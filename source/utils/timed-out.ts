import net from 'net';
import {ClientRequest} from 'http';

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

export interface Delays {
	lookup?: number;
	connect?: number;
	secureConnect?: number;
	socket?: number;
	response?: number;
	send?: number;
	request?: number;
}

export default (request: ClientRequest, delays: Delays, options: any) => {
	/* istanbul ignore next: this makes sure timed-out isn't called twice */
	if (Reflect.has(request, reentry)) {
		return;
	}

	(request as any)[reentry] = true;

	let stopNewTimeouts = false;

	const addTimeout = (delay: number, callback: (...args: any) => void, ...args: any): (() => void) => {
		// An error had been thrown before. Going further would result in uncaught errors.
		// See https://github.com/sindresorhus/got/issues/631#issuecomment-435675051
		if (stopNewTimeouts) {
			return noop;
		}

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

	const cancelers: (() => void)[] = [];
	const cancelTimeouts = (): void => {
		stopNewTimeouts = true;
		cancelers.forEach(cancelTimeout => cancelTimeout());
	};

	request.on('error', (error: Error): void => {
		if (error.message !== 'socket hang up') {
			cancelTimeouts();
		}
	});
	request.once('response', response => {
		response.once('end', cancelTimeouts);
	});

	if (delays.request !== undefined) {
		addTimeout(delays.request, timeoutHandler, 'request');
	}

	if (delays.socket !== undefined) {
		const socketTimeoutHandler = (): void => {
			timeoutHandler(delays.socket as number, 'socket');
		};

		request.setTimeout(delays.socket, socketTimeoutHandler);

		// `request.setTimeout(0)` causes a memory leak.
		// We can just remove the listener and forget about the timer - it's unreffed.
		// See https://github.com/sindresorhus/got/issues/690
		cancelers.push((): void => {
			request.removeListener('timeout', socketTimeoutHandler);
		});
	}

	request.once('socket', (socket: net.Socket): void => {
		const {socketPath} = request as any;

		/* istanbul ignore next: hard to test */
		if (socket.connecting) {
			if (delays.lookup !== undefined && !socketPath && !net.isIP(hostname || host)) {
				const cancelTimeout = addTimeout(delays.lookup as number, timeoutHandler, 'lookup');
				socket.once('lookup', cancelTimeout);
			}

			if (delays.connect !== undefined) {
				const timeConnect = () => addTimeout(delays.connect as number, timeoutHandler, 'connect');

				if (socketPath || net.isIP(hostname || host)) {
					socket.once('connect', timeConnect());
				} else {
					socket.once('lookup', (error: Error): void => {
						if (error === null) {
							socket.once('connect', timeConnect());
						}
					});
				}
			}

			if (delays.secureConnect !== undefined && options.protocol === 'https:') {
				socket.once('connect', (): void => {
					const cancelTimeout = addTimeout(delays.secureConnect as number, timeoutHandler, 'secureConnect');
					socket.once('secureConnect', cancelTimeout);
				});
			}
		}

		if (delays.send !== undefined) {
			const timeRequest = () => addTimeout(delays.send as number, timeoutHandler, 'send');
			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				socket.once('connect', (): void => {
					request.once('upload-complete', timeRequest());
				});
			} else {
				request.once('upload-complete', timeRequest());
			}
		}
	});

	if (delays.response !== undefined) {
		request.once('upload-complete', (): void => {
			const cancelTimeout = addTimeout(delays.response as number, timeoutHandler, 'response');
			request.once('response', cancelTimeout);
		});
	}

	return cancelTimeouts;
};
