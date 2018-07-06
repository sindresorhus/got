'use strict';
const EventEmitter = require('events');
const getStream = require('get-stream');
const is = require('@sindresorhus/is');
const PCancelable = require('p-cancelable');
const pTimeout = require('p-timeout');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ParseError, ReadError, RequestError} = require('./errors');
const normalizeArguments = require('./normalize-arguments');

module.exports = (url, options) => {
	const normalizedArgs = normalizeArguments(url, options);

	const timeoutFn = requestPromise => normalizedArgs.gotTimeout && normalizedArgs.gotTimeout.request ?
		pTimeout(requestPromise, normalizedArgs.gotTimeout.request, new RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, normalizedArgs)) :
		requestPromise;

	const proxy = new EventEmitter();

	const cancelable = new PCancelable((resolve, reject, onCancel) => {
		const emitter = requestAsEventEmitter(normalizedArgs);
		let cancelOnRequest = false;

		onCancel(() => {
			cancelOnRequest = true;
		});

		emitter.on('request', req => {
			if (cancelOnRequest) {
				req.abort();
			}

			onCancel(() => {
				req.abort();
			});

			if (is.nodeStream(normalizedArgs.body)) {
				normalizedArgs.body.pipe(req);
				normalizedArgs.body = undefined;
				return;
			}

			req.end(normalizedArgs.body);
		});

		emitter.on('response', async response => {
			const stream = is.null(normalizedArgs.encoding) ? getStream.buffer(response) : getStream(response, normalizedArgs);

			let data;
			try {
				data = await stream;
			} catch (error) {
				reject(new ReadError(error, normalizedArgs));
				return;
			}

			const {statusCode} = response;
			const limitStatusCode = normalizedArgs.followRedirect ? 299 : 399;

			response.body = data;

			if (normalizedArgs.json && response.body) {
				try {
					response.body = JSON.parse(response.body);
				} catch (error) {
					if (statusCode >= 200 && statusCode < 300) {
						const parseError = new ParseError(error, statusCode, normalizedArgs, data);
						Object.defineProperty(parseError, 'response', {value: response});
						reject(parseError);
					}
				}
			}

			if (normalizedArgs.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const error = new HTTPError(statusCode, response.statusMessage, response.headers, normalizedArgs);
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

	const promise = timeoutFn(cancelable);

	promise.cancel = cancelable.cancel.bind(cancelable);

	promise.on = (name, fn) => {
		proxy.on(name, fn);
		return promise;
	};

	return promise;
};
