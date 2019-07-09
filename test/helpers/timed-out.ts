import {RequestOptions } from 'http';
import http = require('http');
import https = require('https');
import lolex = require('lolex');

export function init() {
	const clock = lolex.createClock();
	let requestWasCreated = false;

	return {
		request: ((options: RequestOptions, cb) => {
			requestWasCreated = true;

			const httpMod = options.protocol === 'https:' ? https : http;
			const req = httpMod.request(options, cb);

			let timeoutTimer;
			let listenerAttached = false;

			req.setTimeout = (delay, timeout) => {
				req.on('socket', socket => {
					listenerAttached = true;
					function updateTimer() {
						clock.clearTimeout(timeoutTimer);
						clock.setTimeout(() => {
							if (listenerAttached) {
								timeout()
							}
						}, delay);
					}

					updateTimer();

					socket.on('data', () => updateTimer());

					const {write} = socket;
					socket.write = (...args) => {
						updateTimer();
						return write.apply(socket, args);
					};
				});
				return req;
			};

			const removeListener = req.removeListener;
			req.removeListener = (event, handler) => {
				if (event !== 'timeout') {
					return removeListener.call(req, event, handler)
				}

				clock.clearTimeout(timeoutTimer);
				listenerAttached = false;
				return req;
			};

			// @ts-ignore
			req.timers = clock;

			return req;
		}) as any,
		tickTimers(ms: number) {
			if (!requestWasCreated) {
				throw new Error('Cannot tick got instance - no request was ever created');
			}

			clock.tick(ms);
			clock.tick(1);
		}
	};
}
