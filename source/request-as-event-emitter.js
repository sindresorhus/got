'use strict';
const {URL} = require('url'); // TODO: Use the `URL` global when targeting Node.js 10
const util = require('util');
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const urlLib = require('url');
const CacheableRequest = require('cacheable-request');
const is = require('@sindresorhus/is');
const timer = require('@szmarczak/http-timer');
const timedOut = require('./timed-out');
const getBodySize = require('./get-body-size');
const getResponse = require('./get-response');
const progress = require('./progress');
const {GotError, CacheError, UnsupportedProtocolError, MaxRedirectsError, RequestError} = require('./errors');

const getMethodRedirectCodes = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes = new Set([300, 303, 307, 308]);

module.exports = options => {
	const emitter = new EventEmitter();
	const requestUrl = options.href || (new URL(options.path, urlLib.format(options))).toString();
	const redirects = [];
	const agents = is.object(options.agent) ? options.agent : null;
	let retryCount = 0;
	let retryTries = 0;
	let redirectUrl;
	let uploadBodySize;

	const setCookie = options.cookieJar ? util.promisify(options.cookieJar.setCookie.bind(options.cookieJar)) : null;
	const getCookieString = options.cookieJar ? util.promisify(options.cookieJar.getCookieString.bind(options.cookieJar)) : null;

	const get = async options => {
		const currentUrl = redirectUrl || requestUrl;

		if (options.protocol !== 'http:' && options.protocol !== 'https:') {
			emitter.emit('error', new UnsupportedProtocolError(options));
			return;
		}

		let fn;
		if (is.function(options.request)) {
			fn = {request: options.request};
		} else {
			fn = options.protocol === 'https:' ? https : http;
		}

		if (agents) {
			const protocolName = options.protocol === 'https:' ? 'https' : 'http';
			options.agent = agents[protocolName] || options.agent;
		}

		/* istanbul ignore next: electron.net is broken */
		if (options.useElectronNet && process.versions.electron) {
			const r = ({x: require})['yx'.slice(1)]; // Trick webpack
			const electron = r('electron');
			fn = electron.net || electron.remote.net;
		}

		if (options.cookieJar) {
			try {
				const cookieString = await getCookieString(currentUrl, {});

				if (!is.empty(cookieString)) {
					options.headers.cookie = cookieString;
				}
			} catch (error) {
				emitter.emit('error', error);
			}
		}

		let timings;
		const cacheableRequest = new CacheableRequest(fn.request, options.cache);
		const cacheReq = cacheableRequest(options, async response => {
			/* istanbul ignore next: fixes https://github.com/electron/electron/blob/cbb460d47628a7a146adf4419ed48550a98b2923/lib/browser/api/net.js#L59-L65 */
			if (options.useElectronNet) {
				response = new Proxy(response, {
					get: (target, name) => {
						if (name === 'trailers' || name === 'rawTrailers') {
							return [];
						}

						const value = target[name];
						return is.function(value) ? value.bind(target) : value;
					}
				});
			}

			const {statusCode} = response;
			response.url = currentUrl;
			response.requestUrl = requestUrl;
			response.retryCount = retryCount;
			response.timings = timings;

			const rawCookies = response.headers['set-cookie'];
			if (options.cookieJar && rawCookies) {
				try {
					await Promise.all(rawCookies.map(rawCookie => setCookie(rawCookie, response.url)));
				} catch (error) {
					emitter.emit('error', error);
				}
			}

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

				try {
					// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
					redirectUrl = (new URL(bufferString, urlLib.format(options))).toString();
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

				await get(redirectOpts);
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

			timings = timer(request);

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
		} catch (error2) {
			emitter.emit('error', error2);
			return;
		}

		if (backoff) {
			retryCount++;
			setTimeout(get, backoff, {...options, forceRefresh: true});
			cb(true);
			return;
		}

		cb(false);
	});

	setImmediate(async () => {
		try {
			uploadBodySize = await getBodySize(options);

			if (is.undefined(options.headers['content-length']) && is.undefined(options.headers['transfer-encoding'])) {
				if (uploadBodySize > 0 || options.method === 'PUT') {
					options.headers['content-length'] = uploadBodySize;
				}
			}

			for (const hook of options.hooks.beforeRequest) {
				// eslint-disable-next-line no-await-in-loop
				await hook(options);
			}

			await get(options);
		} catch (error) {
			emitter.emit('error', error);
		}
	});

	return emitter;
};
