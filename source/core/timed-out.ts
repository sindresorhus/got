import net from 'node:net';
import type {ClientRequest, IncomingMessage} from 'node:http';
import unhandler from './utils/unhandle.js';

const reentry: unique symbol = Symbol('reentry');
const noop = (): void => {};

type TimedOutOptions = {
	host?: string;
	hostname?: string;
	protocol?: string;
};

export type Delays = {
	lookup?: number;
	socket?: number;
	connect?: number;
	secureConnect?: number;
	send?: number;
	response?: number;
	read?: number;
	request?: number;
};

export type ErrorCode =
	| 'ETIMEDOUT'
	| 'ECONNRESET'
	| 'EADDRINUSE'
	| 'ECONNREFUSED'
	| 'EPIPE'
	| 'ENOTFOUND'
	| 'ENETUNREACH'
	| 'EAI_AGAIN';

export class TimeoutError extends Error {
	override name = 'TimeoutError';
	code: ErrorCode = 'ETIMEDOUT';
	event: string;

	constructor(threshold: number, event: string) {
		super(`Timeout awaiting '${event}' for ${threshold}ms`);
		this.event = event;
	}
}

export default function timedOut(request: ClientRequest, delays: Delays, options: TimedOutOptions): () => void {
	if (reentry in request) {
		return noop;
	}

	request[reentry] = true;
	const cancelers: Array<typeof noop> = [];
	const {once, unhandleAll} = unhandler();
	const handled = new Set<string>();

	const addTimeout = (delay: number, callback: (delay: number, event: string) => void, event: string): (typeof noop) => {
		const timeout = setTimeout(callback, delay, delay, event);

		timeout.unref();

		const cancel = (): void => {
			handled.add(event);
			clearTimeout(timeout);
		};

		cancelers.push(cancel);

		return cancel;
	};

	const {host, hostname} = options;

	const timeoutHandler = (delay: number, event: string): void => {
		// Use setTimeout to allow for any cancelled events to be handled first,
		// to prevent firing any TimeoutError unneeded when the event loop is busy or blocked
		setTimeout(() => {
			if (!handled.has(event)) {
				request.destroy(new TimeoutError(delay, event));
			}
		}, 0);
	};

	const cancelTimeouts = (): void => {
		for (const cancel of cancelers) {
			cancel();
		}

		unhandleAll();
	};

	request.once('error', error => {
		cancelTimeouts();

		// Save original behavior
		/* istanbul ignore next */
		if (request.listenerCount('error') === 0) {
			throw error;
		}
	});

	if (delays.socket !== undefined) {
		const {socket} = delays;

		const socketTimeoutHandler = (): void => {
			timeoutHandler(socket, 'socket');
		};

		request.setTimeout(socket, socketTimeoutHandler);

		// `request.setTimeout(0)` causes a memory leak.
		// We can just remove the listener and forget about the timer - it's unreffed.
		// See https://github.com/sindresorhus/got/issues/690
		cancelers.push(() => {
			handled.add('socket');
			request.removeListener('timeout', socketTimeoutHandler);
		});
	}

	const hasLookup = delays.lookup !== undefined;
	const hasConnect = delays.connect !== undefined;
	const hasSecureConnect = delays.secureConnect !== undefined;
	const hasSend = delays.send !== undefined;
	if (hasLookup || hasConnect || hasSecureConnect || hasSend) {
		const onSocket = (socket: net.Socket): void => {
			const {socketPath} = request as ClientRequest & {socketPath?: string};

			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				// WHATWG URL hostnames keep IPv6 brackets, which `net.isIP` rejects. Strip them so IPv6 URLs skip DNS correctly.
				const normalizedHostname = hostname?.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
				const hasPath = Boolean(socketPath ?? (net.isIP(normalizedHostname ?? host ?? '') !== 0));
				// A synchronous lookup can finish before the socket is assigned to the request.
				const hasLookupCompleted = (socket.address() as net.AddressInfo).address !== undefined;

				if (hasLookup && !hasPath && !hasLookupCompleted) {
					const cancelTimeout = addTimeout(delays.lookup!, timeoutHandler, 'lookup');
					once(socket, 'lookup', cancelTimeout);
				}

				if (hasConnect) {
					const timeConnect = (): (() => void) => addTimeout(delays.connect!, timeoutHandler, 'connect');

					if (hasPath || hasLookupCompleted) {
						once(socket, 'connect', timeConnect());
					} else {
						once(socket, 'lookup', (error: Error): void => {
							if (error === null) {
								once(socket, 'connect', timeConnect());
							}
						});
					}
				}

				if (hasSecureConnect && options.protocol === 'https:') {
					once(socket, 'connect', (): void => {
						const cancelTimeout = addTimeout(delays.secureConnect!, timeoutHandler, 'secureConnect');
						once(socket, 'secureConnect', cancelTimeout);
					});
				}
			}

			if (hasSend) {
				const timeRequest = (): (() => void) => addTimeout(delays.send!, timeoutHandler, 'send');
				/* istanbul ignore next: hard to test */
				if (socket.connecting) {
					once(socket, 'connect', (): void => {
						once(request, 'upload-complete', timeRequest());
					});
				} else {
					once(request, 'upload-complete', timeRequest());
				}
			}
		};

		if (request.socket) {
			onSocket(request.socket);
		} else {
			once(request, 'socket', onSocket);
		}
	}

	if (delays.response !== undefined) {
		let cancelTimeout = noop;
		const startTimeout = (): void => {
			cancelTimeout = addTimeout(delays.response!, timeoutHandler, 'response');
		};

		once(request, 'upload-complete', startTimeout);
		once(request, 'response', (): void => {
			// A server can respond before the upload finishes.
			request.removeListener('upload-complete', startTimeout);
			cancelTimeout();
		});
	}

	if (delays.read !== undefined) {
		once(request, 'response', (response: IncomingMessage): void => {
			const cancelTimeout = addTimeout(delays.read!, timeoutHandler, 'read');
			once(response, 'end', cancelTimeout);
		});
	}

	return cancelTimeouts;
}

declare module 'http' {
	// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- This has to be an `interface` to be able to be merged.
	interface ClientRequest {
		[reentry]?: boolean;
	}
}
