'use strict';
const net = require('net');

class TimeoutError extends Error {
	constructor(threshold, event) {
		super(`Timeout awaiting '${event}' for ${threshold}ms`);
		this.name = 'TimeoutError';
		this.code = 'ETIMEDOUT';
		this.event = event;
	}
}

const reentry = Symbol('reentry');

function addTimeout(delay, callback, ...args) {
	// Event loop order is timers, poll, immediates.
	// The timed event may emit during the current tick poll phase, so
	// defer calling the handler until the poll phase completes.
	let immediate;
	const timeout = setTimeout(() => {
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

	const cancel = () => {
		clearTimeout(timeout);
		clearImmediate(immediate);
	};

	return cancel;
}

module.exports = (request, delays, options) => {
	/* istanbul ignore next: this makes sure timed-out isn't called twice */
	if (request[reentry]) {
		return;
	}

	request[reentry] = true;
	const {host, hostname} = options;
	const timeoutHandler = (delay, event) => {
		request.emit('error', new TimeoutError(delay, event));
		request.once('error', () => {}); // Ignore the `socket hung up` error made by request.abort()

		request.abort();
	};

	const cancelers = [];
	const cancelTimeouts = () => {
		cancelers.forEach(cancelTimeout => cancelTimeout());
	};

	request.once('error', cancelTimeouts);
	request.once('response', response => {
		response.once('end', cancelTimeouts);
	});

	if (delays.request !== undefined) {
		const cancelTimeout = addTimeout(delays.request, timeoutHandler, 'request');
		cancelers.push(cancelTimeout);
	}

	if (delays.socket !== undefined) {
		request.setTimeout(delays.socket, () => {
			timeoutHandler(delays.socket, 'socket');
		});
	}

	if (delays.lookup !== undefined && !request.socketPath && !net.isIP(hostname || host)) {
		request.once('socket', socket => {
			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				const cancelTimeout = addTimeout(delays.lookup, timeoutHandler, 'lookup');
				cancelers.push(cancelTimeout);
				socket.once('lookup', cancelTimeout);
			}
		});
	}

	if (delays.connect !== undefined) {
		request.once('socket', socket => {
			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				const timeConnect = () => {
					const cancelTimeout = addTimeout(delays.connect, timeoutHandler, 'connect');
					cancelers.push(cancelTimeout);
					return cancelTimeout;
				};

				if (request.socketPath || net.isIP(hostname || host)) {
					socket.once('connect', timeConnect());
				} else {
					socket.once('lookup', () => {
						socket.once('connect', timeConnect());
					});
				}
			}
		});
	}

	if (delays.secureConnect !== undefined && options.protocol === 'https:') {
		request.once('socket', socket => {
			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				socket.once('connect', () => {
					const cancelTimeout = addTimeout(delays.secureConnect, timeoutHandler, 'secureConnect');
					cancelers.push(cancelTimeout);
					socket.once('secureConnect', cancelTimeout);
				});
			}
		});
	}

	if (delays.send !== undefined) {
		request.once('socket', socket => {
			const timeRequest = () => {
				const cancelTimeout = addTimeout(delays.send, timeoutHandler, 'send');
				cancelers.push(cancelTimeout);
				return cancelTimeout;
			};
			/* istanbul ignore next: hard to test */
			if (socket.connecting) {
				socket.once('connect', () => {
					request.once('upload-complete', timeRequest());
				});
			} else {
				request.once('upload-complete', timeRequest());
			}
		});
	}

	if (delays.response !== undefined) {
		request.once('upload-complete', () => {
			const cancelTimeout = addTimeout(delays.response, timeoutHandler, 'response');
			cancelers.push(cancelTimeout);
			request.once('response', cancelTimeout);
		});
	}
};

module.exports.TimeoutError = TimeoutError;
