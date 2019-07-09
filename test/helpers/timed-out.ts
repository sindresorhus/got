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

			req.setTimeout = (delay, timeout) => {
				req.on('socket', socket => {
					let timer;
					function updateTimer() {
						clock.clearTimeout(timer);
						clock.setTimeout(timeout, delay);
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
