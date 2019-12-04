import net = require('net');
import {ClientRequest, IncomingMessage} from 'http';
import {Delays, ErrorCode} from './types';
import unhandler from './unhandle';

const reentry: unique symbol = Symbol('reentry');
const noop = (): void => {};

interface TimedOutOptions {
	host?: string;
	hostname?: string;
	protocol?: string;
}

export class TimeoutError extends Error {
	code: ErrorCode;

	constructor(threshold: number, public event: string) {
		super(`Timeout awaiting '${event}' for ${threshold}ms`);

		this.name = 'TimeoutError';
		this.code = 'ETIMEDOUT';
	}
}

export default (request: ClientRequest, delays: Delays, options: TimedOutOptions): () => void => {
	if (Reflect.has(request, reentry)) {
		return noop;
	}

	request[reentry] = true;
	const cancelers: Array<typeof noop> = [];
	const {once, unhandleAll} = unhandler();

	const addTimeout = <T extends any[]>(delay: number, callback: (delay: number, ...args: T) => void, ...args: T): (typeof noop) => {
		// Event loop order is timers, poll, immediates.
		// The timed event may emit during the current tick poll phase, so
		// defer calling the handler until the poll phase completes.
		let immediate: NodeJS.Immediate;
		const timeout: NodeJS.Timeout = setTimeout(() => {
			// @ts-ignore https://github.com/microsoft/TypeScript/issues/26113
			immediate = setImmediate(callback, delay, ...args);
			immediate.unref?.();
		}, delay);

		timeout.unref?.();

		const cancel = (): void => {
			clearTimeout(timeout);
			clearImmediate(immediate);
		};

		cancelers.push(cancel);

		return cancel;
	};

	const {host, hostname} = options;

	const timeoutHandler = (delay: number, event: string): void => {
		if (request.socket) {
			// @ts-ignore We do not want the `socket hang up` error
			request.socket._hadError = true;
		}

		request.abort();
		request.emit('error', new TimeoutError(delay, event));
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
		if (request.listenerCount('error') === 0) {
			throw error;
		}
	});

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
		// @ts-ignore Node typings doesn't have this property
		const {socketPath} = request;

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
