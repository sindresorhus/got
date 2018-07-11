'use strict';
const {PassThrough} = require('stream');
const duplexer3 = require('duplexer3');
const is = require('@sindresorhus/is');
const requestAsEventEmitter = require('./request-as-event-emitter');
const {HTTPError, ReadError} = require('./errors');

module.exports = options => {
	const input = new PassThrough();
	const output = new PassThrough();
	const proxy = duplexer3(input, output);

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

	const pipe = proxy.pipe.bind(proxy);
	proxy.pipe = (destination, options) => {
		// TODO: what if pipe gets called after it receives response?
		if (Reflect.has(destination, 'setHeader')) {
			proxy.on('response', response => {
				for (const [key, value] of Object.entries(response.headers)) {
					if (key.toLowerCase() !== 'content-encoding') {
						destination.setHeader(key, value);
					}
				}
			});
		}

		return pipe(destination, options);
	};

	return proxy;
};
