'use strict';
const EventEmitter = require('events');
const getStream = require('get-stream');
const is = require('@sindresorhus/is');
const PCancelable = require('p-cancelable');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ParseError, ReadError} = require('./errors');
const {options: mergeOptions} = require('./merge');
const {reNormalize} = require('./normalize-arguments');

const asPromise = options => {
	const proxy = new EventEmitter();

	const parseBody = response => {
		if (options.responseType === 'json') {
			response.body = JSON.parse(response.body);
		} else if (options.responseType === 'buffer') {
			response.body = Buffer.from(response.body);
		} else if (options.responseType !== 'text' && !is.falsy(options.responseType)) {
			throw new Error(`Failed to parse body of type '${options.responseType}'`);
		}
	};

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

			const limitStatusCode = options.followRedirect ? 299 : 399;

			response.body = data;

			try {
				for (const [index, hook] of Object.entries(options.hooks.afterResponse)) {
					// eslint-disable-next-line no-await-in-loop
					response = await hook(response, updatedOptions => {
						updatedOptions = reNormalize(mergeOptions(options, {
							...updatedOptions,
							retry: 0,
							throwHttpErrors: false
						}));

						// Remove any further hooks for that request, because we we'll call them anyway.
						// The loop continues. We don't want duplicates (asPromise recursion).
						updatedOptions.hooks.afterResponse = options.hooks.afterResponse.slice(0, index);

						return asPromise(updatedOptions);
					});
				}
			} catch (error) {
				reject(error);
				return;
			}

			const {statusCode} = response;

			if (response.body) {
				try {
					parseBody(response);
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

					resolve(options.resolveBodyOnly ? response.body : response);
				}

				return;
			}

			resolve(options.resolveBodyOnly ? response.body : response);
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

	promise.json = () => {
		options.responseType = 'json';
		options.resolveBodyOnly = true;
		return promise;
	};

	promise.buffer = () => {
		options.responseType = 'buffer';
		options.resolveBodyOnly = true;
		return promise;
	};

	promise.text = () => {
		options.responseType = 'text';
		options.resolveBodyOnly = true;
		return promise;
	};

	return promise;
};

module.exports = asPromise;
