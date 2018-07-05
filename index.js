'use strict';
const util = require('util');
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const {PassThrough, Transform} = require('stream');
const urlLib = require('url');
const fs = require('fs');
const querystring = require('querystring');
const extend = require('extend');
const CacheableRequest = require('cacheable-request');
const duplexer3 = require('duplexer3');
const toReadableStream = require('to-readable-stream');
const is = require('@sindresorhus/is');
const getStream = require('get-stream');
const timedOut = require('timed-out');
const urlParseLax = require('url-parse-lax');
const urlToOptions = require('url-to-options');
const lowercaseKeys = require('lowercase-keys');
const decompressResponse = require('decompress-response');
const mimicResponse = require('mimic-response');
const isRetryAllowed = require('is-retry-allowed');
const isURL = require('isurl');
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

const getBodySize = async opts => {
	const {body} = opts;

	if (opts.headers['content-length']) {
		return Number(opts.headers['content-length']);
	}

	if (!body && !opts.stream) {
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

function requestAsEventEmitter(opts) {
	opts = opts || {};

	const ee = new EventEmitter();
	const requestUrl = opts.href || urlLib.resolve(urlLib.format(opts), opts.path);
	const redirects = [];
	const agents = is.object(opts.agent) ? opts.agent : null;
	let retryCount = 0;
	let redirectUrl;
	let uploadBodySize;
	let uploaded = 0;

	const get = opts => {
		if (opts.protocol !== 'http:' && opts.protocol !== 'https:') {
			ee.emit('error', new got.UnsupportedProtocolError(opts));
			return;
		}

		let fn = opts.protocol === 'https:' ? https : http;

		if (agents) {
			const protocolName = opts.protocol === 'https:' ? 'https' : 'http';
			opts.agent = agents[protocolName] || opts.agent;
		}

		if (opts.useElectronNet && process.versions.electron) {
			const electron = require('electron');
			fn = electron.net || electron.remote.net;
		}

		let progressInterval;

		const cacheableRequest = new CacheableRequest(fn.request, opts.cache);
		const cacheReq = cacheableRequest(opts, res => {
			clearInterval(progressInterval);

			ee.emit('uploadProgress', {
				percent: 1,
				transferred: uploaded,
				total: uploadBodySize
			});

			const {statusCode} = res;

			res.url = redirectUrl || requestUrl;
			res.requestUrl = requestUrl;

			const followRedirect = opts.followRedirect && 'location' in res.headers;
			const redirectGet = followRedirect && getMethodRedirectCodes.has(statusCode);
			const redirectAll = followRedirect && allMethodRedirectCodes.has(statusCode);

			if (redirectAll || (redirectGet && (opts.method === 'GET' || opts.method === 'HEAD'))) {
				res.resume();

				if (statusCode === 303) {
					// Server responded with "see other", indicating that the resource exists at another location,
					// and the client should request it from that location via GET or HEAD.
					opts.method = 'GET';
				}

				if (redirects.length >= 10) {
					ee.emit('error', new got.MaxRedirectsError(statusCode, redirects, opts), null, res);
					return;
				}

				const bufferString = Buffer.from(res.headers.location, 'binary').toString();

				redirectUrl = urlLib.resolve(urlLib.format(opts), bufferString);

				try {
					decodeURI(redirectUrl);
				} catch (err) {
					ee.emit('error', err);
					return;
				}

				redirects.push(redirectUrl);

				const redirectOpts = {
					...opts,
					...urlLib.parse(redirectUrl)
				};

				ee.emit('redirect', res, redirectOpts);

				get(redirectOpts);

				return;
			}

			setImmediate(() => {
				try {
					getResponse(res, opts, ee, redirects);
				} catch (err) {
					ee.emit('error', err);
				}
			});
		});

		cacheReq.on('error', err => {
			if (err instanceof CacheableRequest.RequestError) {
				ee.emit('error', new got.RequestError(err, opts));
			} else {
				ee.emit('error', new got.CacheError(err, opts));
			}
		});

		cacheReq.once('request', req => {
			let aborted = false;
			req.once('abort', _ => {
				aborted = true;
			});

			req.once('error', err => {
				clearInterval(progressInterval);

				if (aborted) {
					return;
				}

				const backoff = opts.retries(++retryCount, err);

				if (backoff) {
					setTimeout(opts => {
						try {
							get(opts);
						} catch (e) {
							ee.emit('error', e);
						}
					}, backoff, opts);
					return;
				}

				ee.emit('error', new got.RequestError(err, opts));
			});

			ee.once('request', req => {
				ee.emit('uploadProgress', {
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

							ee.emit('uploadProgress', {
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

			if (opts.gotTimeout) {
				clearInterval(progressInterval);
				timedOut(req, opts.gotTimeout);
			}

			setImmediate(() => {
				ee.emit('request', req);
			});
		});
	};

	setImmediate(async () => {
		try {
			uploadBodySize = await getBodySize(opts);

			// This is the second try at setting a `content-length` header.
			// This supports getting the size async, in contrast to
			// https://github.com/sindresorhus/got/blob/82763c8089596dcee5eaa7f57f5dbf8194842fe6/index.js#L579-L582
			// TODO: We should unify these two at some point
			if (
				uploadBodySize > 0 &&
				is.undefined(opts.headers['content-length']) &&
				is.undefined(opts.headers['transfer-encoding'])
			) {
				opts.headers['content-length'] = uploadBodySize;
			}

			get(opts);
		} catch (err) {
			ee.emit('error', err);
		}
	});

	return ee;
}

function getResponse(res, opts, ee, redirects) {
	const downloadBodySize = Number(res.headers['content-length']) || null;
	let downloaded = 0;

	const progressStream = new Transform({
		transform(chunk, encoding, callback) {
			downloaded += chunk.length;

			const percent = downloadBodySize ? downloaded / downloadBodySize : 0;

			// Let flush() be responsible for emitting the last event
			if (percent < 1) {
				ee.emit('downloadProgress', {
					percent,
					transferred: downloaded,
					total: downloadBodySize
				});
			}

			callback(null, chunk);
		},

		flush(callback) {
			ee.emit('downloadProgress', {
				percent: 1,
				transferred: downloaded,
				total: downloadBodySize
			});

			callback();
		}
	});

	mimicResponse(res, progressStream);
	progressStream.redirectUrls = redirects;

	const response = opts.decompress === true &&
		is.function(decompressResponse) &&
		opts.method !== 'HEAD' ? decompressResponse(progressStream) : progressStream;

	if (!opts.decompress && ['gzip', 'deflate'].includes(res.headers['content-encoding'])) {
		opts.encoding = null;
	}

	ee.emit('response', response);

	ee.emit('downloadProgress', {
		percent: 0,
		transferred: 0,
		total: downloadBodySize
	});

	res.pipe(progressStream);
}

function asPromise(opts) {
	const timeoutFn = requestPromise => opts.gotTimeout && opts.gotTimeout.request ?
		pTimeout(requestPromise, opts.gotTimeout.request, new got.RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, opts)) :
		requestPromise;

	const proxy = new EventEmitter();

	const cancelable = new PCancelable((resolve, reject, onCancel) => {
		const ee = requestAsEventEmitter(opts);
		let cancelOnRequest = false;

		onCancel(() => {
			cancelOnRequest = true;
		});

		ee.on('request', req => {
			if (cancelOnRequest) {
				req.abort();
			}

			onCancel(() => {
				req.abort();
			});

			if (is.nodeStream(opts.body)) {
				opts.body.pipe(req);
				opts.body = undefined;
				return;
			}

			req.end(opts.body);
		});

		ee.on('response', async res => {
			const stream = is.null(opts.encoding) ? getStream.buffer(res) : getStream(res, opts);

			let data;
			try {
				data = await stream;
			} catch (err) {
				reject(new got.ReadError(err, opts));
				return;
			}

			const {statusCode} = res;
			const limitStatusCode = opts.followRedirect ? 299 : 399;

			res.body = data;

			if (opts.json && res.body) {
				try {
					res.body = JSON.parse(res.body);
				} catch (err) {
					if (statusCode >= 200 && statusCode < 300) {
						const parseError = new got.ParseError(err, statusCode, opts, data);
						Object.defineProperty(parseError, 'response', {value: res});
						reject(parseError);
					}
				}
			}

			if (opts.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const err = new got.HTTPError(statusCode, res.statusMessage, res.headers, opts);
				Object.defineProperty(err, 'response', {value: res});
				reject(err);
			}

			resolve(res);
		});

		ee.once('error', reject);
		ee.on('redirect', proxy.emit.bind(proxy, 'redirect'));
		ee.on('uploadProgress', proxy.emit.bind(proxy, 'uploadProgress'));
		ee.on('downloadProgress', proxy.emit.bind(proxy, 'downloadProgress'));
	});

	const promise = timeoutFn(cancelable);

	promise.cancel = cancelable.cancel.bind(cancelable);

	promise.on = (name, fn) => {
		proxy.on(name, fn);
		return promise;
	};

	return promise;
}

function asStream(opts) {
	opts.stream = true;

	const input = new PassThrough();
	const output = new PassThrough();
	const proxy = duplexer3(input, output);
	let timeout;

	if (opts.gotTimeout && opts.gotTimeout.request) {
		timeout = setTimeout(() => {
			proxy.emit('error', new got.RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, opts));
		}, opts.gotTimeout.request);
	}

	if (opts.json) {
		throw new Error('Got can not be used as a stream when the `json` option is used');
	}

	if (opts.body) {
		proxy.write = () => {
			throw new Error('Got\'s stream is not writable when the `body` option is used');
		};
	}

	const ee = requestAsEventEmitter(opts);

	ee.on('request', req => {
		proxy.emit('request', req);

		if (is.nodeStream(opts.body)) {
			opts.body.pipe(req);
			return;
		}

		if (opts.body) {
			req.end(opts.body);
			return;
		}

		if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
			input.pipe(req);
			return;
		}

		req.end();
	});

	ee.on('response', res => {
		clearTimeout(timeout);

		const {statusCode} = res;

		res.on('error', err => {
			proxy.emit('error', new got.ReadError(err, opts));
		});

		res.pipe(output);

		if (opts.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > 299)) {
			proxy.emit('error', new got.HTTPError(statusCode, res.statusMessage, res.headers, opts), null, res);
			return;
		}

		proxy.emit('response', res);
	});

	ee.on('error', proxy.emit.bind(proxy, 'error'));
	ee.on('redirect', proxy.emit.bind(proxy, 'redirect'));
	ee.on('uploadProgress', proxy.emit.bind(proxy, 'uploadProgress'));
	ee.on('downloadProgress', proxy.emit.bind(proxy, 'downloadProgress'));

	return proxy;
}

function normalizeArguments(url, opts) {
	if (!is.string(url) && !is.object(url)) {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${is(url)}`);
	} else if (is.string(url)) {
		url = url.replace(/^unix:/, 'http://$&');

		try {
			decodeURI(url);
		} catch (err) {
			throw new Error('Parameter `url` must contain valid UTF-8 character sequences');
		}

		url = urlParseLax(url);
		if (url.auth) {
			throw new Error('Basic authentication must be done with the `auth` option');
		}
	} else if (isURL.lenient(url)) {
		url = urlToOptions(url);
	}

	opts = {
		path: '',
		...url,
		protocol: url.protocol || 'http:', // Override both null/undefined with default protocol
		...opts
	};

	const headers = lowercaseKeys(opts.headers);
	if (!Object.keys(headers).includes('user-agent')) {
		headers['user-agent'] = `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (is.nullOrUndefined(value)) {
			delete headers[key];
		}
	}

	opts.headers = headers;

	if (opts.decompress && is.undefined(opts.headers['accept-encoding'])) {
		opts.headers['accept-encoding'] = 'gzip, deflate';
	}

	const {query} = opts;

	if (query) {
		if (!is.string(query)) {
			opts.query = querystring.stringify(query);
		}

		opts.path = `${opts.path.split('?')[0]}?${opts.query}`;
		delete opts.query;
	}

	if (opts.json && is.undefined(opts.headers.accept)) {
		opts.headers.accept = 'application/json';
	}

	const {body} = opts;
	if (is.nullOrUndefined(body)) {
		opts.method = (opts.method || 'GET').toUpperCase();
	} else {
		const {headers} = opts;
		if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body) && !(opts.form || opts.json)) {
			throw new TypeError('The `body` option must be a stream.Readable, string, Buffer or plain Object');
		}

		const canBodyBeStringified = is.plainObject(body) || is.array(body);
		if ((opts.form || opts.json) && !canBodyBeStringified) {
			throw new TypeError('The `body` option must be a plain Object or Array when the `form` or `json` option is used');
		}

		if (isFormData(body)) {
			// Special case for https://github.com/form-data/form-data
			headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
		} else if (opts.form && canBodyBeStringified) {
			headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
			opts.body = querystring.stringify(body);
		} else if (opts.json && canBodyBeStringified) {
			headers['content-type'] = headers['content-type'] || 'application/json';
			opts.body = JSON.stringify(body);
		}

		if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding']) && !is.nodeStream(body)) {
			const length = is.string(opts.body) ? Buffer.byteLength(opts.body) : opts.body.length;
			headers['content-length'] = length;
		}

		// Convert buffer to stream to receive upload progress events (#322)
		if (is.buffer(body)) {
			opts.body = toReadableStream(body);
			opts.body._buffer = body;
		}

		opts.method = (opts.method || 'POST').toUpperCase();
	}

	if (opts.hostname === 'unix') {
		const matches = /(.+?):(.+)/.exec(opts.path);

		if (matches) {
			const [, socketPath, path] = matches;
			opts = {
				...opts,
				socketPath,
				path,
				host: null
			};
		}
	}

	if (!is.function(opts.retries)) {
		const {retries} = opts;

		opts.retries = (iter, err) => {
			if (iter > retries || !isRetryAllowed(err)) {
				return 0;
			}

			const noise = Math.random() * 100;

			return ((1 << iter) * 1000) + noise;
		};
	}

	if (is.undefined(opts.followRedirect)) {
		opts.followRedirect = true;
	}

	if (opts.timeout) {
		if (is.number(opts.timeout)) {
			opts.gotTimeout = {request: opts.timeout};
		} else {
			opts.gotTimeout = opts.timeout;
		}
		delete opts.timeout;
	}

	return opts;
}

function create(defaults = {}) {
	function got(url, opts) {
		try {
			opts = extend(true, {}, defaults, opts);
			const normalizedArgs = normalizeArguments(url, opts);

			if (normalizedArgs.stream) {
				return asStream(normalizedArgs);
			}

			return asPromise(normalizedArgs);
		} catch (err) {
			return Promise.reject(err);
		}
	}

	got.create = (opts = {}) => create(extend(true, {}, defaults, opts));

	got.stream = (url, opts) => {
		opts = extend(true, {}, defaults, opts);
		return asStream(normalizeArguments(url, opts));
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
