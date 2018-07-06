'use strict';
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const URLGlobal = typeof URL === 'undefined' ? require('url').URL : URL; // TODO: Use the `URL` global when targeting Node.js 10
const urlLib = require('url');
const CacheableRequest = require('cacheable-request');
const is = require('@sindresorhus/is');
const timedOut = require('timed-out');
const getBodySize = require('./get-body-size');
const getResponse = require('./get-response');
const {CacheError, UnsupportedProtocolError, MaxRedirectsError, RequestError} = require('./errors');

const getMethodRedirectCodes = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes = new Set([300, 303, 307, 308]);

module.exports = (options = {}) => {
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
			emitter.emit('error', new UnsupportedProtocolError(options));
			return;
		}

		let fn = options.protocol === 'https:' ? https : http;

		if (agents) {
			const protocolName = options.protocol === 'https:' ? 'https' : 'http';
			options.agent = agents[protocolName] || options.agent;
		}

		if (options.useElectronNet && process.versions.electron) {
			const electron = global['require']('electron'); // eslint-disable-line dot-notation
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
					emitter.emit('error', new MaxRedirectsError(statusCode, redirects, options), null, response);
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
				emitter.emit('error', new RequestError(error, options));
			} else {
				emitter.emit('error', new CacheError(error, options));
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

				emitter.emit('error', new RequestError(error, options));
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
};
