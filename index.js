'use strict';
const util = require('util');
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const {PassThrough, Transform} = require('stream');
const urlLib = require('url');
const fs = require('fs');
const URLGlobal = typeof URL === 'undefined' ? require('url').URL : URL; // TODO: Use the `URL` global when targeting Node.js 10
const URLSearchParamsGlobal = typeof URLSearchParams === 'undefined' ? require('url').URLSearchParams : URLSearchParams; // TODO: Use the `URL` global when targeting Node.js 10
const extend = require('extend');
const CacheableRequest = require('cacheable-request');
const duplexer3 = require('duplexer3');
const toReadableStream = require('to-readable-stream');
const is = require('@sindresorhus/is');
const getStream = require('get-stream');
const timedOut = require('timed-out');
const urlParseLax = require('url-parse-lax');
const urlToOptions = require('url-to-options');
const decompressResponse = require('decompress-response');
const mimicResponse = require('mimic-response');
const isRetryAllowed = require('is-retry-allowed');
const PCancelable = require('p-cancelable');
const pTimeout = require('p-timeout');
const pkg = require('./package.json');
const errors = require('./errors');

const getMethodRedirectCodes = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes = new Set([300, 303, 307, 308]);

const defaults = {
	retries: 2,
	cache: false,
	decompress: true,
	useElectronNet: false,
	throwHttpErrors: true,
	headers: {
		'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
	}
};

const got = create(defaults);

const isFormData = body => is.nodeStream(body) && is.function(body.getBoundary);

const getBodySize = async options => {
	const {body} = options;

	if (options.headers['content-length']) {
		return Number(options.headers['content-length']);
	}

	if (!body && !options.stream) {
		return 0;
	}

	if (is.string(body)) {
		return Buffer.byteLength(body);
	}

	if (isFormData(body)) {
		return util.promisify(body.getLength.bind(body))();
	}

	if (body instanceof fs.ReadStream) {
		const {size} = await util.promisify(fs.stat)(body.path);
		return size;
	}

	if (is.nodeStream(body) && is.buffer(body._buffer)) {
		return body._buffer.length;
	}

	return null;
};

function requestAsEventEmitter(options = {}) {
	const emitter = new EventEmitter();
	const requestUrl = options.href || (new URLGlobal(options.path, urlLib.format(options))).toString();
	const redirects = [];
	const agents = is.object(options.agent) ? options.agent : null;
	let retryCount = 0;
	let redirectUrl;
	let uploadBodySize;
	let uploaded = 0;

	const get = options => {
		if (options.protocol !== 'http:' && options.protocol !== 'https:') {
			emitter.emit('error', new got.UnsupportedProtocolError(options));
			return;
		}

		let fn = options.protocol === 'https:' ? https : http;

		if (agents) {
			const protocolName = options.protocol === 'https:' ? 'https' : 'http';
			options.agent = agents[protocolName] || options.agent;
		}

		if (options.useElectronNet && process.versions.electron) {
			const electron = require('electron');
			fn = electron.net || electron.remote.net;
		}

		let progressInterval;

		const cacheableRequest = new CacheableRequest(fn.request, options.cache);
		const cacheReq = cacheableRequest(options, response => {
			clearInterval(progressInterval);

			emitter.emit('uploadProgress', {
				percent: 1,
				transferred: uploaded,
				total: uploadBodySize
			});

			const {statusCode} = response;

			response.url = redirectUrl || requestUrl;
			response.requestUrl = requestUrl;

			const followRedirect = options.followRedirect && 'location' in response.headers;
			const redirectGet = followRedirect && getMethodRedirectCodes.has(statusCode);
			const redirectAll = followRedirect && allMethodRedirectCodes.has(statusCode);

			if (redirectAll || (redirectGet && (options.method === 'GET' || options.method === 'HEAD'))) {
				response.resume();

				if (statusCode === 303) {
					// Server responded with "see other", indicating that the resource exists at another location,
					// and the client should request it from that location via GET or HEAD.
					options.method = 'GET';
				}

				if (redirects.length >= 10) {
					emitter.emit('error', new got.MaxRedirectsError(statusCode, redirects, options), null, response);
					return;
				}

				const bufferString = Buffer.from(response.headers.location, 'binary').toString();
				redirectUrl = (new URLGlobal(bufferString, urlLib.format(options))).toString();

				try {
					redirectUrl = decodeURI(redirectUrl);
				} catch (error) {
					emitter.emit('error', error);
					return;
				}

				redirects.push(redirectUrl);

				const redirectOpts = {
					...options,
					...urlLib.parse(redirectUrl)
				};

				emitter.emit('redirect', response, redirectOpts);

				get(redirectOpts);

				return;
			}

			setImmediate(() => {
				try {
					getResponse(response, options, emitter, redirects);
				} catch (error) {
					emitter.emit('error', error);
				}
			});
		});

		cacheReq.on('error', error => {
			if (error instanceof CacheableRequest.RequestError) {
				emitter.emit('error', new got.RequestError(error, options));
			} else {
				emitter.emit('error', new got.CacheError(error, options));
			}
		});

		cacheReq.once('request', req => {
			let aborted = false;
			req.once('abort', _ => {
				aborted = true;
			});

			req.once('error', error => {
				clearInterval(progressInterval);

				if (aborted) {
					return;
				}

				const backoff = options.retries(++retryCount, error);

				if (backoff) {
					setTimeout(options => {
						try {
							get(options);
						} catch (error2) {
							emitter.emit('error', error2);
						}
					}, backoff, options);
					return;
				}

				emitter.emit('error', new got.RequestError(error, options));
			});

			emitter.once('request', req => {
				emitter.emit('uploadProgress', {
					percent: 0,
					transferred: 0,
					total: uploadBodySize
				});

				const socket = req.connection;
				if (socket) {
					const onSocketConnect = () => {
						const uploadEventFrequency = 150;

						progressInterval = setInterval(() => {
							if (socket.destroyed) {
								clearInterval(progressInterval);
								return;
							}

							const lastUploaded = uploaded;
							const headersSize = req._header ? Buffer.byteLength(req._header) : 0;
							uploaded = socket.bytesWritten - headersSize;

							// Prevent the known issue of `bytesWritten` being larger than body size
							if (uploadBodySize && uploaded > uploadBodySize) {
								uploaded = uploadBodySize;
							}

							// Don't emit events with unchanged progress and
							// prevent last event from being emitted, because
							// it's emitted when `response` is emitted
							if (uploaded === lastUploaded || uploaded === uploadBodySize) {
								return;
							}

							emitter.emit('uploadProgress', {
								percent: uploadBodySize ? uploaded / uploadBodySize : 0,
								transferred: uploaded,
								total: uploadBodySize
							});
						}, uploadEventFrequency);
					};

					// Only subscribe to `connect` event if we're actually connecting a new
					// socket, otherwise if we're already connected (because this is a
					// keep-alive connection) do not bother. This is important since we won't
					// get a `connect` event for an already connected socket.
					if (socket.connecting) {
						socket.once('connect', onSocketConnect);
					} else {
						onSocketConnect();
					}
				}
			});

			if (options.gotTimeout) {
				clearInterval(progressInterval);
				timedOut(req, options.gotTimeout);
			}

			setImmediate(() => {
				emitter.emit('request', req);
			});
		});
	};

	setImmediate(async () => {
		try {
			uploadBodySize = await getBodySize(options);

			// This is the second try at setting a `content-length` header.
			// This supports getting the size async, in contrast to
			// https://github.com/sindresorhus/got/blob/82763c8089596dcee5eaa7f57f5dbf8194842fe6/index.js#L579-L582
			// TODO: We should unify these two at some point
			if (
				uploadBodySize > 0 &&
				is.undefined(options.headers['content-length']) &&
				is.undefined(options.headers['transfer-encoding'])
			) {
				options.headers['content-length'] = uploadBodySize;
			}

			get(options);
		} catch (error) {
			emitter.emit('error', error);
		}
	});

	return emitter;
}

function getResponse(response, options, emitter, redirects) {
	const downloadBodySize = Number(response.headers['content-length']) || null;
	let downloaded = 0;

	const progressStream = new Transform({
		transform(chunk, encoding, callback) {
			downloaded += chunk.length;

			const percent = downloadBodySize ? downloaded / downloadBodySize : 0;

			// Let flush() be responsible for emitting the last event
			if (percent < 1) {
				emitter.emit('downloadProgress', {
					percent,
					transferred: downloaded,
					total: downloadBodySize
				});
			}

			callback(null, chunk);
		},

		flush(callback) {
			emitter.emit('downloadProgress', {
				percent: 1,
				transferred: downloaded,
				total: downloadBodySize
			});

			callback();
		}
	});

	mimicResponse(response, progressStream);
	progressStream.redirectUrls = redirects;

	const newResponse = options.decompress === true &&
		is.function(decompressResponse) &&
		options.method !== 'HEAD' ? decompressResponse(progressStream) : progressStream;

	if (!options.decompress && ['gzip', 'deflate'].includes(response.headers['content-encoding'])) {
		options.encoding = null;
	}

	emitter.emit('response', newResponse);

	emitter.emit('downloadProgress', {
		percent: 0,
		transferred: 0,
		total: downloadBodySize
	});

	response.pipe(progressStream);
}

function asPromise(options) {
	const timeoutFn = requestPromise => options.gotTimeout && options.gotTimeout.request ?
		pTimeout(requestPromise, options.gotTimeout.request, new got.RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, options)) :
		requestPromise;

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
			const stream = is.null(options.encoding) ? getStream.buffer(response) : getStream(response, options);

			let data;
			try {
				data = await stream;
			} catch (error) {
				reject(new got.ReadError(error, options));
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
						const parseError = new got.ParseError(error, statusCode, options, data);
						Object.defineProperty(parseError, 'response', {value: response});
						reject(parseError);
					}
				}
			}

			if (options.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const error = new got.HTTPError(statusCode, response.statusMessage, response.headers, options);
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
}

function asStream(options) {
	options.stream = true;

	const input = new PassThrough();
	const output = new PassThrough();
	const proxy = duplexer3(input, output);
	let timeout;

	if (options.gotTimeout && options.gotTimeout.request) {
		timeout = setTimeout(() => {
			proxy.emit('error', new got.RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, options));
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
			proxy.emit('error', new got.ReadError(error, options));
		});

		response.pipe(output);

		if (options.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > 299)) {
			proxy.emit('error', new got.HTTPError(statusCode, response.statusMessage, response.headers, options), null, response);
			return;
		}

		proxy.emit('response', response);
	});

	emitter.on('error', proxy.emit.bind(proxy, 'error'));
	emitter.on('redirect', proxy.emit.bind(proxy, 'redirect'));
	emitter.on('uploadProgress', proxy.emit.bind(proxy, 'uploadProgress'));
	emitter.on('downloadProgress', proxy.emit.bind(proxy, 'downloadProgress'));

	return proxy;
}

function normalizeArguments(url, options) {
	if (!is.string(url) && !is.object(url)) {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${is(url)}`);
	} else if (is.string(url)) {
		url = url.replace(/^unix:/, 'http://$&');

		try {
			decodeURI(url);
		} catch (_) {
			throw new Error('Parameter `url` must contain valid UTF-8 character sequences');
		}

		url = urlParseLax(url);
		if (url.auth) {
			throw new Error('Basic authentication must be done with the `auth` option');
		}
	} else if (is(url) === 'URL') {
		url = urlToOptions(url);
	}

	options = {
		path: '',
		...url,
		protocol: url.protocol || 'http:', // Override both null/undefined with default protocol
		...options
	};

	for (const [key, value] of Object.entries(options.headers)) {
		if (is.nullOrUndefined(value)) {
			delete options.headers[key];
			continue;
		}

		options.headers[key.toLowerCase()] = value;
	}

	if (options.decompress && is.undefined(options.headers['accept-encoding'])) {
		options.headers['accept-encoding'] = 'gzip, deflate';
	}

	const {query} = options;
	if (query) {
		if (!is.string(query)) {
			options.query = (new URLSearchParamsGlobal(query)).toString();
		}

		options.path = `${options.path.split('?')[0]}?${options.query}`;
		delete options.query;
	}

	if (options.json && is.undefined(options.headers.accept)) {
		options.headers.accept = 'application/json';
	}

	const {body} = options;
	if (is.nullOrUndefined(body)) {
		options.method = (options.method || 'GET').toUpperCase();
	} else {
		const {headers} = options;
		if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body) && !(options.form || options.json)) {
			throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
		}

		if (options.json && !(is.plainObject(body) || is.array(body))) {
			throw new TypeError('The `body` option must be a plain Object or Array when the `json` option is used');
		}

		if (options.form && !is.plainObject(body)) {
			throw new TypeError('The `body` option must be a plain Object when the `form` option is used');
		}

		if (isFormData(body)) {
			// Special case for https://github.com/form-data/form-data
			headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
		} else if (options.form && is.plainObject(body)) {
			headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
			options.body = (new URLSearchParamsGlobal(body)).toString();
		} else if (options.json && (is.plainObject(body) || is.array(body))) {
			headers['content-type'] = headers['content-type'] || 'application/json';
			options.body = JSON.stringify(body);
		}

		if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding']) && !is.nodeStream(body)) {
			const length = is.string(options.body) ? Buffer.byteLength(options.body) : options.body.length;
			headers['content-length'] = length;
		}

		// Convert buffer to stream to receive upload progress events (#322)
		if (is.buffer(body)) {
			options.body = toReadableStream(body);
			options.body._buffer = body;
		}

		options.method = (options.method || 'POST').toUpperCase();
	}

	if (options.hostname === 'unix') {
		const matches = /(.+?):(.+)/.exec(options.path);

		if (matches) {
			const [, socketPath, path] = matches;
			options = {
				...options,
				socketPath,
				path,
				host: null
			};
		}
	}

	if (!is.function(options.retries)) {
		const {retries} = options;

		options.retries = (iter, error) => {
			if (iter > retries || !isRetryAllowed(error)) {
				return 0;
			}

			const noise = Math.random() * 100;

			return ((1 << iter) * 1000) + noise;
		};
	}

	if (is.undefined(options.followRedirect)) {
		options.followRedirect = true;
	}

	if (options.timeout) {
		if (is.number(options.timeout)) {
			options.gotTimeout = {request: options.timeout};
		} else {
			options.gotTimeout = options.timeout;
		}
		delete options.timeout;
	}

	return options;
}

function create(defaults = {}) {
	function got(url, options) {
		try {
			options = extend(true, {}, defaults, options);
			const normalizedArgs = normalizeArguments(url, options);

			if (normalizedArgs.stream) {
				return asStream(normalizedArgs);
			}

			return asPromise(normalizedArgs);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = (options = {}) => create(extend(true, {}, defaults, options));

	got.stream = (url, options) => {
		options = extend(true, {}, defaults, options);
		return asStream(normalizeArguments(url, options));
	};

	const methods = [
		'get',
		'post',
		'put',
		'patch',
		'head',
		'delete'
	];

	for (const method of methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);

	return got;
}

module.exports = got;
