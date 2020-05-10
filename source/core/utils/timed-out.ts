import net = require('net');
import {ClientRequest, IncomingMessage} from 'http';
import unhandler from './unhandle';

const reentry: unique symbol = Symbol('reentry');
const noop = (): void => {};

interface TimedOutOptions {
	host?: string;
	hostname?: string;
	protocol?: string;
}

export interface Delays {
	lookup?: number;
	connect?: number;
	secureConnect?: number;
	socket?: number;
	response?: number;
	send?: number;
	request?: number;
}

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

export default (request: ClientRequest, delays: Delays, options: TimedOutOptions): () => void => {
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

	request.once('close', cancelTimeouts);

	once(request, 'response', (response: IncomingMessage): void => {
		once(response, 'end', cancelTimeouts);
	});

	if (typeof delays.request !== 'undefined') {
		addTimeout(delays.request, timeoutHandler, 'request');
	}

	if (typeof delays.socket !== 'undefined') {
		const socketTimeoutHandler = (): void => {
			timeoutHandler(delays.socket!, 'socket');
		};

		request.setTimeout(delays.socket, socketTimeoutHandler);

		// `request.setTimeout(0)` causes a memory leak.
		// We can just remove the listener and forget about the timer - it's unreffed.
		// See https://github.com/sindresorhus/got/issues/690
		cancelers.push(() => {
			request.removeListener('timeout', socketTimeoutHandler);
		});
	}

	once(request, 'socket', (socket: net.Socket): void => {
		const {socketPath} = request as ClientRequest & {socketPath?: string};

		/* istanbul ignore next: hard to test */
		if (socket.connecting) {
			const hasPath = Boolean(socketPath ?? net.isIP(hostname ?? host ?? '') !== 0);

			if (typeof delays.lookup !== 'undefined' && !hasPath && typeof (socket.address() as net.AddressInfo).address === 'undefined') {
				const cancelTimeout = addTimeout(delays.lookup, timeoutHandler, 'lookup');
				once(socket, 'lookup', cancelTimeout);
			}

			if (typeof delays.connect !== 'undefined') {
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

			if (typeof delays.secureConnect !== 'undefined' && options.protocol === 'https:') {
				once(socket, 'connect', (): void => {
					const cancelTimeout = addTimeout(delays.secureConnect!, timeoutHandler, 'secureConnect');
					once(socket, 'secureConnect', cancelTimeout);
				});
			}
		}

		if (typeof delays.send !== 'undefined') {
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

	if (typeof delays.response !== 'undefined') {
		once(request, 'upload-complete', (): void => {
			const cancelTimeout = addTimeout(delays.response!, timeoutHandler, 'response');
			once(request, 'response', cancelTimeout);
		});
	}

	return cancelTimeouts;
};

declare module 'http' {
	interface ClientRequest {
		[reentry]: boolean;
	}
}
