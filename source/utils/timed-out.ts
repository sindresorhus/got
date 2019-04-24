import net from 'net';
import {ClientRequest, IncomingMessage} from 'http';
import {Delays} from './types';
import unhandler from './unhandle';

export class TimeoutError extends Error {
	event: string;

	code: string;

	constructor(threshold: number, event: string) {
		super(`Timeout awaiting '${event}' for ${threshold}ms`);

		this.name = 'TimeoutError';
		this.code = 'ETIMEDOUT';
		this.event = event;
	}
}

const reentry: symbol = Symbol('reentry');
const noop = (): void => {};

export default (request: ClientRequest, delays: Delays, options: any) => {
	if (Reflect.has(request, reentry)) {
		return noop;
	}

	(request as any)[reentry] = true;
	const cancelers: (typeof noop)[] = [];
	const {once, unhandleAll} = unhandler();

	const addTimeout = (delay: number, callback: (...args: any) => void, ...args: any): (typeof noop) => {
		// Event loop order is timers, poll, immediates.
		// The timed event may emit during the current tick poll phase, so
		// defer calling the handler until the poll phase completes.
		let immediate: NodeJS.Immediate;
		const timeout: NodeJS.Timeout = setTimeout(() => {
			immediate = setImmediate(callback, delay, ...args);
			/* istanbul ignore next: added in node v9.7.0 */
			if (immediate.unref) {
				immediate.unref();
			}
		}, delay);

		/* istanbul ignore next: in order to support electron renderer */
		if (timeout.unref) {
			timeout.unref();
		}

		const cancel = (): void => {
			clearTimeout(timeout);
			clearImmediate(immediate);
		};

		cancelers.push(cancel);

		return cancel;
	};

	const {host, hostname} = options;
	const timeoutHandler = (delay: number, event: string): void => {
		request.emit('error', new TimeoutError(delay, event));
		request.abort();
	};

	const cancelTimeouts = (): void => {
		cancelers.forEach(cancelTimeout => cancelTimeout());
		unhandleAll();
	};

	request.on('error', (error: Error): void => {
		if (error.message !== 'socket hang up') {
			cancelTimeouts();
		}
	});

	once(request, 'response', (response: IncomingMessage) => {
		once(response, 'end', cancelTimeouts);
	});

	if (delays.request !== undefined) {
		addTimeout(delays.request, timeoutHandler, 'request');
	}

	if (delays.socket !== undefined) {
		const socketTimeoutHandler = (): void => {
			timeoutHandler(delays.socket!, 'socket');
		};

		request.setTimeout(delays.socket, socketTimeoutHandler);

		// `request.setTimeout(0)` causes a memory leak.
		// We can just remove the listener and forget about the timer - it's unreffed.
		// See https://github.com/sindresorhus/got/issues/690
		cancelers.push((): void => {
			request.removeListener('timeout', socketTimeoutHandler);
		});
	}

	once(request, 'socket', (socket: net.Socket): void => {
		const {socketPath} = request as any;

		/* istanbul ignore next: hard to test */
		if (socket.connecting) {
			if (delays.lookup !== undefined && !socketPath && !net.isIP(hostname || host)) {
				const cancelTimeout = addTimeout(delays.lookup, timeoutHandler, 'lookup');
				once(socket, 'lookup', cancelTimeout);
			}

			if (delays.connect !== undefined) {
				const timeConnect = () => addTimeout(delays.connect!, timeoutHandler, 'connect');

				if (socketPath || net.isIP(hostname || host)) {
					once(socket, 'connect', timeConnect());
				} else {
					once(socket, 'lookup', (error: Error): void => {
						if (error === null) {
							once(socket, 'connect', timeConnect());
						}
					});
				}
			}

			if (delays.secureConnect !== undefined && options.protocol === 'https:') {
				once(socket, 'connect', (): void => {
					const cancelTimeout = addTimeout(delays.secureConnect!, timeoutHandler, 'secureConnect');
					once(socket, 'secureConnect', cancelTimeout);
				});
			}
		}

		if (delays.send !== undefined) {
			const timeRequest = () => addTimeout(delays.send!, timeoutHandler, 'send');
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

	if (delays.response !== undefined) {
		once(request, 'upload-complete', (): void => {
			const cancelTimeout = addTimeout(delays.response!, timeoutHandler, 'response');
			once(request, 'response', cancelTimeout);
		});
	}

	return cancelTimeouts;
};
