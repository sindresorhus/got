'use strict';
const net = require('net');
const {TimeoutError} = require('./errors');

const reentry = Symbol('reentry');

function addTimeout(delay, callback, ...args) {
	// Event loop order is timers, poll, immediates.
	// The timed event may emit during the current tick poll phase, so
	// defer calling the handler until the poll phase completes.
	let immediate;
	const timeout = setTimeout(
		() => {
			immediate = setImmediate(callback, delay, ...args);
			if (immediate.unref) {
				// Added in node v9.7.0
				immediate.unref();
			}
		},
		delay
	);
	timeout.unref();
	return () => {
		clearTimeout(timeout);
		clearImmediate(immediate);
	};
}

module.exports = function (req, options) {
	if (req[reentry]) {
		return;
	}
	req[reentry] = true;
	const {gotTimeout: delays, host, hostname} = options;
	const timeoutHandler = (delay, event) => {
		req.abort();
		req.emit('error', new TimeoutError(delay, event, options));
	};
	const cancelers = [];
	const cancelTimeouts = () => {
		cancelers.forEach(cancelTimeout => cancelTimeout());
	};

	req.on('error', cancelTimeouts);
	req.once('response', response => {
		response.once('end', cancelTimeouts);
	});

	if (delays.request !== undefined) {
		const cancelTimeout = addTimeout(
			delays.request,
			timeoutHandler,
			'request'
		);
		cancelers.push(cancelTimeout);
	}
	if (delays.socket !== undefined) {
		req.setTimeout(
			delays.socket,
			() => {
				timeoutHandler(delays.socket, 'socket');
			}
		);
	}
	if (delays.lookup !== undefined && !req.socketPath && !net.isIP(hostname || host)) {
		req.once('socket', socket => {
			if (socket.connecting) {
				const cancelTimeout = addTimeout(
					delays.lookup,
					timeoutHandler,
					'lookup'
				);
				cancelers.push(cancelTimeout);
				socket.once('lookup', cancelTimeout);
			}
		});
	}
	if (delays.connect !== undefined) {
		req.once('socket', socket => {
			if (socket.connecting) {
				const timeConnect = () => {
					const cancelTimeout = addTimeout(
						delays.connect,
						timeoutHandler,
						'connect'
					);
					cancelers.push(cancelTimeout);
					return cancelTimeout;
				};
				if (req.socketPath || net.isIP(hostname || host)) {
					socket.once('connect', timeConnect());
				} else {
					socket.once('lookup', () => {
						socket.once('connect', timeConnect());
					});
				}
			}
		});
	}
	if (delays.send !== undefined) {
		req.once('socket', socket => {
			const timeRequest = () => {
				const cancelTimeout = addTimeout(
					delays.send,
					timeoutHandler,
					'send'
				);
				cancelers.push(cancelTimeout);
				return cancelTimeout;
			};
			if (socket.connecting) {
				socket.once('connect', () => {
					req.once('upload-complete', timeRequest());
				});
			} else {
				req.once('upload-complete', timeRequest());
			}
		});
	}
	if (delays.response !== undefined) {
		req.once('upload-complete', () => {
			const cancelTimeout = addTimeout(
				delays.response,
				timeoutHandler,
				'response'
			);
			cancelers.push(cancelTimeout);
			req.once('response', cancelTimeout);
		});
	}
};
