'use strict';
const EventEmitter = require('events');
const getStream = require('get-stream');
const is = require('@sindresorhus/is');
const PCancelable = require('p-cancelable');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ParseError, ReadError} = require('./errors');

module.exports = options => {
	const proxy = new EventEmitter();

	const cancelable = new PCancelable((resolve, reject, onCancel) => {
		const emitter = requestAsEventEmitter(options);
		let cancelOnRequest = false;

		onCancel(() => {
			cancelOnRequest = true;
		});

		emitter.on('request', req => {
			if (cancelOnRequest) {
				req.abort();
			}

			proxy.emit('request', req);

			onCancel(() => {
				req.abort();
			});

			if (is.nodeStream(options.body)) {
				options.body.pipe(req);
				options.body = undefined;
				return;
			}

			req.end(options.body);
		});

		emitter.on('response', async response => {
			proxy.emit('response', response);

			const stream = is.null(options.encoding) ? getStream.buffer(response) : getStream(response, options);

			let data;
			try {
				data = await stream;
			} catch (error) {
				reject(new ReadError(error, options));
				return;
			}

			const {statusCode} = response;
			const limitStatusCode = options.followRedirect ? 299 : 399;

			response.body = data;

			if (options.json && response.body) {
				try {
					response.body = JSON.parse(response.body);
				} catch (error) {
					if (statusCode >= 200 && statusCode < 300) {
						const parseError = new ParseError(error, statusCode, options, data);
						Object.defineProperty(parseError, 'response', {value: response});
						reject(parseError);
					}
				}
			}

			if (options.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const error = new HTTPError(statusCode, response.statusMessage, response.headers, options);
				Object.defineProperty(error, 'response', {value: response});
				reject(error);
			}

			resolve(response);
		});

		emitter.once('error', reject);
		emitter.on('redirect', proxy.emit.bind(proxy, 'redirect'));
		emitter.on('uploadProgress', proxy.emit.bind(proxy, 'uploadProgress'));
		emitter.on('downloadProgress', proxy.emit.bind(proxy, 'downloadProgress'));
	});

	const promise = cancelable;

	promise.cancel = cancelable.cancel.bind(cancelable);

	promise.on = (name, fn) => {
		proxy.on(name, fn);
		return promise;
	};

	return promise;
};
