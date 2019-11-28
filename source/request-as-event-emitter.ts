import CacheableRequest = require('cacheable-request');
import EventEmitter = require('events');
import http = require('http');
import stream = require('stream');
import {promisify} from 'util';
import is from '@sindresorhus/is';
import timer from '@szmarczak/http-timer';
import {ProxyStream} from './as-stream';
import calculateRetryDelay from './calculate-retry-delay';
import {CacheError, GotError, MaxRedirectsError, RequestError, TimeoutError} from './errors';
import getResponse from './get-response';
import {normalizeRequestArguments} from './normalize-arguments';
import {createProgressStream} from './progress';
import timedOut, {TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import {GeneralError, NormalizedOptions, Response, ResponseObject} from './utils/types';
import urlToOptions from './utils/url-to-options';

const setImmediateAsync = async (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const pipeline = promisify(stream.pipeline);

const redirectCodes: ReadonlySet<number> = new Set([300, 301, 302, 303, 304, 307, 308]);

export interface RequestAsEventEmitter extends EventEmitter {
	retry: <T extends GotError>(error: T) => boolean;
	abort: () => void;
}

export default (options: NormalizedOptions): RequestAsEventEmitter => {
	const emitter = new EventEmitter() as RequestAsEventEmitter;

	const requestURL = options.url.toString();
	const redirects: string[] = [];
	let retryCount = 0;

	let currentRequest: http.ClientRequest;

	const emitError = async (error: GeneralError): Promise<void> => {
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

				const typedResponse = response as Response;
				const {statusCode} = typedResponse;
				typedResponse.statusMessage = is.nonEmptyString(typedResponse.statusMessage) ? typedResponse.statusMessage : http.STATUS_CODES[statusCode];
				typedResponse.url = options.url.toString();
				typedResponse.requestUrl = requestURL;
				typedResponse.retryCount = retryCount;
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
					let promises: Array<Promise<unknown>> = rawCookies.map(async (rawCookie: string) => options.cookieJar.setCookie(rawCookie, typedResponse.url));

					if (options.ignoreInvalidCookies) {
						promises = promises.map(async p => p.catch(() => {}));
					}

					await Promise.all(promises);
				}

				if (options.followRedirect && Reflect.has(typedResponse.headers, 'location') && redirectCodes.has(statusCode)) {
					typedResponse.resume(); // We're being redirected, we don't care about the response.

					if (statusCode === 303 || options.methodRewriting === false) {
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

				await getResponse(typedResponse, options, emitter);
			} catch (error) {
				emitError(error);
			}
		};

		const handleRequest = async (request: http.ClientRequest): Promise<void> => {
			// `request.aborted` is a boolean since v11.0.0: https://github.com/nodejs/node/commit/4b00c4fafaa2ae8c41c1f78823c0feb810ae4723#diff-e3bc37430eb078ccbafe3aa3b570c91a
			const isAborted = (): boolean => typeof request.aborted === 'number' || (request.aborted as unknown as boolean);

			currentRequest = request;

			const onError = (error: GeneralError): void => {
				if (error instanceof TimedOutTimeoutError) {
					error = new TimeoutError(error, request.timings!, options);
				} else {
					error = new RequestError(error, options);
				}

				if (!emitter.retry(error as GotError)) {
					emitError(error);
				}
			};

			const attachErrorHandler = (): void => {
				request.once('error', error => {
					// We need to allow `TimedOutTimeoutError` here, because `stream.pipeline(…)` aborts the request automatically.
					if (isAborted() && !(error instanceof TimedOutTimeoutError)) {
						return;
					}

					onError(error);
				});
			};

			try {
				timer(request);
				timedOut(request, options.timeout, options.url);

				emitter.emit('request', request);

				const uploadStream = createProgressStream('uploadProgress', emitter, httpOptions.headers!['content-length'] as string);

				await pipeline(
					httpOptions.body!,
					uploadStream,
					request
				);

				attachErrorHandler();

				request.emit('upload-complete');
			} catch (error) {
				if (isAborted() && error.message === 'Premature close') {
					// The request was aborted on purpose
					return;
				}

				onError(error);

				// Handle future errors
				attachErrorHandler();
			}
		};

		if (options.cache) {
			// `cacheable-request` doesn't support Node 10 API, fallback.
			httpOptions = {
				...httpOptions,
				...urlToOptions(options.url)
			};

			// @ts-ignore ResponseLike missing socket field, should be fixed upstream
			const cacheRequest = options.cacheableRequest!(httpOptions, handleResponse);

			cacheRequest.once('error', (error: GeneralError) => {
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
				// @ts-ignore URLSearchParams does not equal URLSearchParams
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
		emitter.prependListener('request', (request: http.ClientRequest) => {
			request.abort();
		});

		if (currentRequest) {
			currentRequest.abort();
		}
	};

	(async () => {
		// Promises are executed immediately.
		// If there were no `setImmediate` here,
		// `promise.json()` would have no effect
		// as the request would be sent already.
		await setImmediateAsync();

		try {
			for (const hook of options.hooks.beforeRequest) {
				// eslint-disable-next-line no-await-in-loop
				await hook(options);
			}

			await get();
		} catch (error) {
			emitError(error);
		}
	})();

	return emitter;
};

export const proxyEvents = (proxy: EventEmitter | ProxyStream, emitter: RequestAsEventEmitter): void => {
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
