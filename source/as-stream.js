'use strict';
const {PassThrough} = require('stream');
const duplexer3 = require('duplexer3');
const is = require('@sindresorhus/is');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ReadError, RequestError} = require('./errors');

module.exports = options => {
	options.stream = true;

	const input = new PassThrough();
	const output = new PassThrough();
	const proxy = duplexer3(input, output);
	let timeout;

	if (options.gotTimeout && options.gotTimeout.request) {
		timeout = setTimeout(() => {
			proxy.emit('error', new RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, options));
		}, options.gotTimeout.request);
	}

	if (options.json) {
		throw new Error('Got can not be used as a stream when the `json` option is used');
	}

	if (options.body) {
		proxy.write = () => {
			throw new Error('Got\'s stream is not writable when the `body` option is used');
		};
	}

	const emitter = requestAsEventEmitter(options);

	emitter.on('request', req => {
		proxy.emit('request', req);

		if (is.nodeStream(options.body)) {
			options.body.pipe(req);
			return;
		}

		if (options.body) {
			req.end(options.body);
			return;
		}

		if (options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH') {
			input.pipe(req);
			return;
		}

		req.end();
	});

	emitter.on('response', response => {
		clearTimeout(timeout);

		const {statusCode} = response;

		response.on('error', error => {
			proxy.emit('error', new ReadError(error, options));
		});

		response.pipe(output);

		if (options.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > 299)) {
			proxy.emit('error', new HTTPError(statusCode, response.statusMessage, response.headers, options), null, response);
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
