'use strict';
const {PassThrough} = require('stream');
const duplexer3 = require('duplexer3');
const is = require('@sindresorhus/is');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ReadError, RequestError} = require('./errors');
const normalizeArguments = require('./normalize-arguments');

module.exports = (url, options) => {
	const normalizedArgs = normalizeArguments(url, options);
	normalizedArgs.stream = true;

	const input = new PassThrough();
	const output = new PassThrough();
	const proxy = duplexer3(input, output);
	let timeout;

	if (normalizedArgs.gotTimeout && normalizedArgs.gotTimeout.request) {
		timeout = setTimeout(() => {
			proxy.emit('error', new RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, normalizedArgs));
		}, normalizedArgs.gotTimeout.request);
	}

	if (normalizedArgs.json) {
		throw new Error('Got can not be used as a stream when the `json` option is used');
	}

	if (normalizedArgs.body) {
		proxy.write = () => {
			throw new Error('Got\'s stream is not writable when the `body` option is used');
		};
	}

	const emitter = requestAsEventEmitter(normalizedArgs);

	emitter.on('request', req => {
		proxy.emit('request', req);

		if (is.nodeStream(normalizedArgs.body)) {
			normalizedArgs.body.pipe(req);
			return;
		}

		if (normalizedArgs.body) {
			req.end(normalizedArgs.body);
			return;
		}

		if (normalizedArgs.method === 'POST' || normalizedArgs.method === 'PUT' || normalizedArgs.method === 'PATCH') {
			input.pipe(req);
			return;
		}

		req.end();
	});

	emitter.on('response', response => {
		clearTimeout(timeout);

		const {statusCode} = response;

		response.on('error', error => {
			proxy.emit('error', new ReadError(error, normalizedArgs));
		});

		response.pipe(output);

		if (normalizedArgs.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > 299)) {
			proxy.emit('error', new HTTPError(statusCode, response.statusMessage, response.headers, normalizedArgs), null, response);
			return;
		}

		proxy.emit('response', response);
	});

	emitter.on('error', proxy.emit.bind(proxy, 'error'));
	emitter.on('redirect', proxy.emit.bind(proxy, 'redirect'));
	emitter.on('uploadProgress', proxy.emit.bind(proxy, 'uploadProgress'));
	emitter.on('downloadProgress', proxy.emit.bind(proxy, 'downloadProgress'));

	return proxy;
};
