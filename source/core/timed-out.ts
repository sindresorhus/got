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
	code: ErrorCode;

	constructor(threshold: number, public event: string) {
		super(`Timeout awaiting '${event}' for ${threshold}ms`);

		this.name = 'TimeoutError';
		this.code = 'ETIMEDOUT';
	}
}

export default function timedOut(request: ClientRequest, delays: Delays, options: TimedOutOptions): () => void {
	if (reentry in request) {
		return noop;
	}

	request[reentry] = true;
	const cancelers: Array<typeof noop> = [];
	const {once, unhandleAll} = unhandler();

	const addTimeout = (delay: number, callback: (delay: number, event: string) => void, event: string): (typeof noop) => {
		const timeout = setTimeout(callback, delay, delay, event) as unknown as NodeJS.Timeout;

		timeout.unref?.();

		const cancel = (): void => {
			clearTimeout(timeout);
		};

		cancelers.push(cancel);

		return cancel;
	};

	const {host, hostname} = options;

	const timeoutHandler = (delay: number, event: string): void => {
		request.destroy(new TimeoutError(delay, event));
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

	if (delays.request !== undefined) {
		const cancelTimeout = addTimeout(delays.request, timeoutHandler, 'request');

		once(request, 'response', (response: IncomingMessage): void => {
			once(response, 'end', cancelTimeout);
		});
	}

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
			request.removeListener('timeout', socketTimeoutHandler);
		});
	}

	const hasLookup = delays.lookup !== undefined;
	const hasConnect = delays.connect !== undefined;
	const hasSecureConnect = delays.secureConnect !== undefined;
	const hasSend = delays.send !== undefined;
	if (hasLookup || hasConnect || hasSecureConnect || hasSend) {
		once(request, 'socket', (socket: net.Socket): void => {
			const {socketPath} = request as ClientRequest & {socketPath?: string};

			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				const hasPath = Boolean(socketPath ?? net.isIP(hostname ?? host ?? '') !== 0);

				if (hasLookup && !hasPath && (socket.address() as net.AddressInfo).address === undefined) {
					const cancelTimeout = addTimeout(delays.lookup!, timeoutHandler, 'lookup');
					once(socket, 'lookup', cancelTimeout);
				}

				if (hasConnect) {
					const timeConnect = (): (() => void) => addTimeout(delays.connect!, timeoutHandler, 'connect');

					if (hasPath) {
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
		});
	}

	if (delays.response !== undefined) {
		once(request, 'upload-complete', (): void => {
			const cancelTimeout = addTimeout(delays.response!, timeoutHandler, 'response');
			once(request, 'response', cancelTimeout);
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
