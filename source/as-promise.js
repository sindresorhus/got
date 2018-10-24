'use strict';
const EventEmitter = require('events');
const getStream = require('get-stream');
const is = require('@sindresorhus/is');
const PCancelable = require('p-cancelable');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ParseError, ReadError} = require('./errors');

module.exports = options => {
	const proxy = new EventEmitter();

	const promise = new PCancelable((resolve, reject, onCancel) => {
		const emitter = requestAsEventEmitter(options);

		onCancel(emitter.abort);

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
						return;
					}
				}
			}

			if (statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const error = new HTTPError(response, options);
				Object.defineProperty(error, 'response', {value: response});
				if (emitter.retry(error) === false) {
					if (options.throwHttpErrors) {
						reject(error);
						return;
					}

					resolve(response);
				}
				return;
			}

			resolve(response);
		});

		emitter.once('error', reject);
		[
			'request',
			'redirect',
			'uploadProgress',
			'downloadProgress'
		].forEach(event => emitter.on(event, (...args) => proxy.emit(event, ...args)));
	});

	promise.on = (name, fn) => {
		proxy.on(name, fn);
		return promise;
	};

	return promise;
};
