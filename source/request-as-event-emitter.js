'use strict';
/* istanbul ignore next: compatibility reason */
const URLGlobal = typeof URL === 'undefined' ? require('url').URL : URL; // TODO: Use the `URL` global when targeting Node.js 10
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const urlLib = require('url');
const CacheableRequest = require('cacheable-request');
const is = require('@sindresorhus/is');
const timedOut = require('./timed-out');
const getBodySize = require('./get-body-size');
const getResponse = require('./get-response');
const progress = require('./progress');
const {GotError, CacheError, UnsupportedProtocolError, MaxRedirectsError, RequestError} = require('./errors');

const getMethodRedirectCodes = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes = new Set([300, 303, 307, 308]);

module.exports = options => {
	const emitter = new EventEmitter();
	const requestUrl = options.href || (new URLGlobal(options.path, urlLib.format(options))).toString();
	const redirects = [];
	const agents = is.object(options.agent) ? options.agent : null;
	let retryCount = 0;
	let retryTries = 0;
	let redirectUrl;
	let uploadBodySize;

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

		/* istanbul ignore next: electron.net is broken */
		if (options.useElectronNet && process.versions.electron) {
			const electron = global['require']('electron'); // eslint-disable-line dot-notation
			fn = electron.net || electron.remote.net;
		}

		const cacheableRequest = new CacheableRequest(fn.request, options.cache);
		const cacheReq = cacheableRequest(options, response => {
			const {statusCode} = response;
			response.retryCount = retryCount;
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
					decodeURI(redirectUrl);
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

			try {
				getResponse(response, options, emitter, redirects);
			} catch (error) {
				emitter.emit('error', error);
			}
		});

		cacheReq.on('error', error => {
			if (error instanceof CacheableRequest.RequestError) {
				emitter.emit('error', new RequestError(error, options));
			} else {
				emitter.emit('error', new CacheError(error, options));
			}
		});

		cacheReq.once('request', request => {
			let aborted = false;
			request.once('abort', _ => {
				aborted = true;
			});

			request.once('error', error => {
				if (aborted) {
					return;
				}

				if (!(error instanceof GotError)) {
					error = new RequestError(error, options);
				}
				emitter.emit('retry', error, retried => {
					if (!retried) {
						emitter.emit('error', error);
					}
				});
			});

			progress.upload(request, emitter, uploadBodySize);

			if (options.gotTimeout) {
				timedOut(request, options);
			}

			emitter.emit('request', request);
		});
	};

	emitter.on('retry', (error, cb) => {
		let backoff;
		try {
			backoff = options.gotRetry.retries(++retryTries, error);
		} catch (error) {
			emitter.emit('error', error);
			return;
		}

		if (backoff) {
			retryCount++;
			setTimeout(get, backoff, options);
			cb(true);
			return;
		}

		cb(false);
	});

	setImmediate(async () => {
		try {
			uploadBodySize = await getBodySize(options);

			if (
				uploadBodySize > 0 &&
				is.undefined(options.headers['content-length']) &&
				is.undefined(options.headers['transfer-encoding'])
			) {
				options.headers['content-length'] = uploadBodySize;
			}

			for (const hook of options.hooks.beforeRequest) {
				// eslint-disable-next-line no-await-in-loop
				await hook(options);
			}

			get(options);
		} catch (error) {
			emitter.emit('error', error);
		}
	});

	return emitter;
};
