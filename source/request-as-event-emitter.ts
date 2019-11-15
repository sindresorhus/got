import stream = require('stream');
import EventEmitter = require('events');
import http = require('http');
import CacheableRequest = require('cacheable-request');
import is from '@sindresorhus/is';
import timer, {Timings} from '@szmarczak/http-timer';
import timedOut, {TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import calculateRetryDelay from './calculate-retry-delay';
import getResponse from './get-response';
import {normalizeRequestArguments} from './normalize-arguments';
import {uploadProgress} from './progress';
import {CacheError, MaxRedirectsError, RequestError, TimeoutError} from './errors';
import urlToOptions from './utils/url-to-options';
import {NormalizedOptions, Response, ResponseObject} from './utils/types';

const redirectCodes: ReadonlySet<number> = new Set([300, 301, 302, 303, 304, 307, 308]);

export interface RequestAsEventEmitter extends EventEmitter {
	retry: <T extends Error>(error: T) => boolean;
	abort: () => void;
}

export default (options: NormalizedOptions) => {
	const emitter = new EventEmitter() as RequestAsEventEmitter;

	const requestURL = options.url.toString();
	const redirects: string[] = [];
	let retryCount = 0;

	let currentRequest: http.ClientRequest;
	let shouldAbort = false;

	const emitError = async (error: Error): Promise<void> => {
		try {
			for (const hook of options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}

			emitter.emit('error', error);
		} catch (error_) {
			emitter.emit('error', error_);
		}
	};

	const get = async (): Promise<void> => {
		let httpOptions = await normalizeRequestArguments(options);

		let timings: Timings;
		const handleResponse = async (response: http.ServerResponse | ResponseObject): Promise<void> => {
			try {
				/* istanbul ignore next: fixes https://github.com/electron/electron/blob/cbb460d47628a7a146adf4419ed48550a98b2923/lib/browser/api/net.js#L59-L65 */
				if (options.useElectronNet) {
					response = new Proxy(response, {
						get: (target, name) => {
							if (name === 'trailers' || name === 'rawTrailers') {
								return [];
							}

							const value = (target as any)[name];
							return is.function_(value) ? value.bind(target) : value;
						}
					});
				}

				const {statusCode} = response;
				const typedResponse = response as Response;
				// This is intentionally using `||` over `??` so it can also catch empty status message.
				typedResponse.statusMessage = typedResponse.statusMessage || http.STATUS_CODES[statusCode];
				typedResponse.url = options.url.toString();
				typedResponse.requestUrl = requestURL;
				typedResponse.retryCount = retryCount;
				typedResponse.timings = timings;
				typedResponse.redirectUrls = redirects;
				typedResponse.request = {options};
				typedResponse.isFromCache = typedResponse.fromCache ?? false;
				delete typedResponse.fromCache;

				if (!typedResponse.isFromCache) {
					// @ts-ignore Node.js typings haven't been updated yet
					typedResponse.ip = response.socket.remoteAddress;
				}

				const rawCookies = typedResponse.headers['set-cookie'];
				if (Reflect.has(options, 'cookieJar') && rawCookies) {
					let promises: Array<Promise<unknown>> = rawCookies.map((rawCookie: string) => options.cookieJar.setCookie(rawCookie, typedResponse.url));

					if (options.ignoreInvalidCookies) {
						promises = promises.map(p => p.catch(() => {}));
					}

					await Promise.all(promises);
				}

				if (options.followRedirect && Reflect.has(typedResponse.headers, 'location') && redirectCodes.has(statusCode)) {
					typedResponse.resume(); // We're being redirected, we don't care about the response.

					if (statusCode === 303) {
						if (options.method !== 'GET' && options.method !== 'HEAD') {
							// Server responded with "see other", indicating that the resource exists at another location,
							// and the client should request it from that location via GET or HEAD.
							options.method = 'GET';
						}

						delete options.body;
						delete options.json;
						delete options.form;
					}

					if (redirects.length >= options.maxRedirects) {
						throw new MaxRedirectsError(typedResponse, options.maxRedirects, options);
					}

					// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
					const redirectBuffer = Buffer.from(typedResponse.headers.location, 'binary').toString();
					const redirectURL = new URL(redirectBuffer, options.url);

					// Redirecting to a different site, clear cookies.
					if (redirectURL.hostname !== options.url.hostname) {
						delete options.headers.cookie;
					}

					redirects.push(redirectURL.toString());
					options.url = redirectURL;

					for (const hook of options.hooks.beforeRedirect) {
						// eslint-disable-next-line no-await-in-loop
						await hook(options, typedResponse);
					}

					emitter.emit('redirect', response, options);

					await get();
					return;
				}

				getResponse(typedResponse, options, emitter);
			} catch (error) {
				emitError(error);
			}
		};

		const handleRequest = (request: http.ClientRequest): void => {
			if (shouldAbort) {
				request.abort();
				return;
			}

			currentRequest = request;

			// `request.aborted` is a boolean since v11.0.0: https://github.com/nodejs/node/commit/4b00c4fafaa2ae8c41c1f78823c0feb810ae4723#diff-e3bc37430eb078ccbafe3aa3b570c91a
			// We need to allow `TimedOutTimeoutError` here, because it `stream.pipeline(…)` aborts it automatically.
			const isAborted = () => typeof request.aborted === 'number' || (request.aborted as unknown as boolean) === true;

			const onError = (error: Error): void => {
				const isTimedOutError = error instanceof TimedOutTimeoutError;

				if (!isTimedOutError && isAborted()) {
					return;
				}

				if (isTimedOutError) {
					// @ts-ignore TS is dumb.
					error = new TimeoutError(error, timings, options);
				} else {
					error = new RequestError(error, options);
				}

				if (emitter.retry(error) === false) {
					emitError(error);
				}
			};

			const uploadComplete = (error?: Error): void => {
				if (error) {
					onError(error);
					return;
				}

				// No need to attach an error handler here,
				// as `stream.pipeline(…)` doesn't remove this handler
				// to allow stream reuse.

				request.emit('upload-complete');
			};

			request.on('error', onError);

			timings = timer(request); // TODO: Make `@szmarczak/http-timer` set `request.timings` and `response.timings`

			const uploadBodySize = httpOptions.headers['content-length'] ? Number(httpOptions.headers['content-length']) : undefined;
			uploadProgress(request, emitter, uploadBodySize);

			timedOut(request, options.timeout, options.url);

			emitter.emit('request', request);

			if (isAborted()) {
				return;
			}

			try {
				if (options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH') {
					if (is.nodeStream(httpOptions.body)) {
						// `stream.pipeline(…)` handles `error` for us.
						request.removeListener('error', onError);

						stream.pipeline(
							// @ts-ignore Upgrade `@sindresorhus/is`
							httpOptions.body,
							request,
							uploadComplete
						);
					} else {
						request.end(httpOptions.body, uploadComplete);
					}
				} else {
					request.end(uploadComplete);
				}
			} catch (error) {
				emitError(new RequestError(error, options));
			}
		};

		if (options.cache) {
			// `cacheable-request` doesn't support Node 10 API, fallback.
			httpOptions = {
				...httpOptions,
				...urlToOptions(options.url)
			};

			const cacheRequest = options.cacheableRequest(httpOptions, handleResponse);

			cacheRequest.once('error', error => {
				if (error instanceof CacheableRequest.RequestError) {
					emitError(new RequestError(error, options));
				} else {
					emitError(new CacheError(error, options));
				}
			});

			cacheRequest.once('request', handleRequest);
		} else {
			// Catches errors thrown by calling `requestFn(…)`
			try {
				// @ts-ignore 1. TS complains that URLSearchParams is not the same as URLSearchParams.
				//            2. It doesn't notice that `options.timeout` is deleted above.
				handleRequest(httpOptions.request(options.url, httpOptions, handleResponse));
			} catch (error) {
				emitError(new RequestError(error, options));
			}
		}
	};

	emitter.retry = error => {
		let backoff: number;

		retryCount++;

		try {
			backoff = options.retry.calculateDelay({
				attemptCount: retryCount,
				retryOptions: options.retry,
				error,
				computedValue: calculateRetryDelay({
					attemptCount: retryCount,
					retryOptions: options.retry,
					error,
					computedValue: 0
				})
			});
		} catch (error_) {
			emitError(error_);
			return false;
		}

		if (backoff) {
			const retry = async (options: NormalizedOptions): Promise<void> => {
				try {
					for (const hook of options.hooks.beforeRetry) {
						// eslint-disable-next-line no-await-in-loop
						await hook(options, error, retryCount);
					}

					await get();
				} catch (error_) {
					emitError(error_);
				}
			};

			setTimeout(retry, backoff, {...options, forceRefresh: true});
			return true;
		}

		return false;
	};

	emitter.abort = () => {
		if (currentRequest) {
			currentRequest.abort();
		} else {
			shouldAbort = true;
		}
	};

	setImmediate(async () => {
		try {
			for (const hook of options.hooks.beforeRequest) {
				// eslint-disable-next-line no-await-in-loop
				await hook(options);
			}

			await get();
		} catch (error) {
			emitError(error);
		}
	});

	return emitter;
};

export const proxyEvents = (proxy, emitter) => {
	const events = [
		'request',
		'redirect',
		'uploadProgress',
		'downloadProgress'
	];

	for (const event of events) {
		emitter.on(event, (...args: unknown[]) => {
			proxy.emit(event, ...args);
		});
	}
};
