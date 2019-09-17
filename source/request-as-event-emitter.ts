import {format, UrlObject} from 'url';
import {promisify} from 'util';
import EventEmitter = require('events');
import {Transform as TransformStream} from 'stream';
import http = require('http');
import https = require('https');
import CacheableRequest = require('cacheable-request');
import toReadableStream = require('to-readable-stream');
import is from '@sindresorhus/is';
import timer, {Timings} from '@szmarczak/http-timer';
import ResponseLike = require('responselike');
import timedOut, {TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import calculateRetryDelay from './calculate-retry-delay';
import getResponse from './get-response';
import {uploadProgress} from './progress';
import {CacheError, UnsupportedProtocolError, MaxRedirectsError, RequestError, TimeoutError} from './errors';
import urlToOptions from './utils/url-to-options';
import {RequestFunction, NormalizedOptions, Response, AgentByProtocol} from './utils/types';
import dynamicRequire from './utils/dynamic-require';

const URLGlobal: typeof URL = typeof URL === 'undefined' ? require('url').URL : URL;
const URLSearchParamsGlobal: typeof URLSearchParams = typeof URLSearchParams === 'undefined' ? require('url').URLSearchParams : URLSearchParams;

export type GetMethodRedirectCodes = 300 | 301 | 302 | 303 | 304 | 305 | 307 | 308;
export type AllMethodRedirectCodes = 300 | 303 | 307 | 308;
export type WithoutBody = 'GET' | 'HEAD';

const getMethodRedirectCodes: ReadonlySet<GetMethodRedirectCodes> = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes: ReadonlySet<AllMethodRedirectCodes> = new Set([300, 303, 307, 308]);
const withoutBody: ReadonlySet<WithoutBody> = new Set(['GET', 'HEAD']);

export interface RequestAsEventEmitter extends EventEmitter {
	retry: <T extends Error>(error: T) => boolean;
	abort: () => void;
}

export default (options: NormalizedOptions, input?: TransformStream) => {
	const emitter = new EventEmitter() as RequestAsEventEmitter;
	const redirects = [] as string[];
	let currentRequest: http.ClientRequest;
	let requestUrl: string;
	let redirectString: string;
	let uploadBodySize: number | undefined;
	let retryCount = 0;
	let shouldAbort = false;

	const setCookie = options.cookieJar ? promisify(options.cookieJar.setCookie.bind(options.cookieJar)) : null;
	const getCookieString = options.cookieJar ? promisify(options.cookieJar.getCookieString.bind(options.cookieJar)) : null;
	const agents = is.object(options.agent) ? options.agent : null;

	const emitError = async (error: Error): Promise<void> => {
		try {
			for (const hook of options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}

			emitter.emit('error', error);
		} catch (error2) {
			emitter.emit('error', error2);
		}
	};

	const get = async (options: NormalizedOptions): Promise<void> => {
		const currentUrl = redirectString || requestUrl;

		if (options.protocol !== 'http:' && options.protocol !== 'https:') {
			throw new UnsupportedProtocolError(options);
		}

		decodeURI(currentUrl);

		let requestFn: RequestFunction;
		if (is.function_(options.request)) {
			requestFn = options.request;
		} else {
			requestFn = options.protocol === 'https:' ? https.request : http.request;
		}

		if (agents) {
			const protocolName = options.protocol === 'https:' ? 'https' : 'http';
			options.agent = (agents as AgentByProtocol)[protocolName] || options.agent;
		}

		/* istanbul ignore next: electron.net is broken */
		// No point in typing process.versions correctly, as
		// process.version.electron is used only once, right here.
		if (options.useElectronNet && (process.versions as any).electron) {
			const electron = dynamicRequire(module, 'electron'); // Trick webpack
			requestFn = (electron as any).net.request || (electron as any).remote.net.request;
		}

		if (options.cookieJar) {
			const cookieString = await getCookieString!(currentUrl);

			if (is.nonEmptyString(cookieString)) {
				options.headers.cookie = cookieString;
			}
		}

		let timings: Timings;
		const handleResponse = async (response: http.ServerResponse | ResponseLike): Promise<void> => {
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
				typedResponse.statusMessage = typedResponse.statusMessage || http.STATUS_CODES[statusCode];
				typedResponse.url = currentUrl;
				typedResponse.requestUrl = requestUrl;
				typedResponse.retryCount = retryCount;
				typedResponse.timings = timings;
				typedResponse.redirectUrls = redirects;
				typedResponse.request = {options};
				typedResponse.isFromCache = typedResponse.fromCache || false;
				delete typedResponse.fromCache;

				const rawCookies = typedResponse.headers['set-cookie'];
				if (options.cookieJar && rawCookies) {
					let promises: Array<Promise<unknown>> = rawCookies.map((rawCookie: string) => setCookie!(rawCookie, typedResponse.url!));
					if (options.ignoreInvalidCookies) {
						promises = promises.map(p => p.catch(() => {}));
					}

					await Promise.all(promises);
				}

				if (options.followRedirect && 'location' in typedResponse.headers) {
					if (allMethodRedirectCodes.has(statusCode as AllMethodRedirectCodes) || (getMethodRedirectCodes.has(statusCode as GetMethodRedirectCodes) && (options.method === 'GET' || options.method === 'HEAD'))) {
						typedResponse.resume(); // We're being redirected, we don't care about the response.

						if (statusCode === 303) {
							// Server responded with "see other", indicating that the resource exists at another location,
							// and the client should request it from that location via GET or HEAD.
							options.method = 'GET';
						}

						if (redirects.length >= 10) {
							throw new MaxRedirectsError(typedResponse, options);
						}

						// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
						const redirectBuffer = Buffer.from(typedResponse.headers.location!, 'binary').toString();
						const redirectURL = new URLGlobal(redirectBuffer, currentUrl);
						redirectString = redirectURL.toString();

						redirects.push(redirectString);

						const redirectOptions = {
							...options,
							port: undefined,
							auth: undefined,
							...urlToOptions(redirectURL)
						};

						for (const hook of options.hooks.beforeRedirect) {
							// eslint-disable-next-line no-await-in-loop
							await hook(redirectOptions, typedResponse);
						}

						emitter.emit('redirect', response, redirectOptions);

						await get(redirectOptions);
						return;
					}
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

			request.on('error', error => {
				if (typeof request.aborted === 'number' || error.message === 'socket hang up') {
					return;
				}

				if (error instanceof TimedOutTimeoutError) {
					error = new TimeoutError(error, timings, options);
				} else {
					error = new RequestError(error, options);
				}

				if (emitter.retry(error) === false) {
					emitError(error);
				}
			});

			timings = timer(request);

			uploadProgress(request, emitter, uploadBodySize);

			if (options.gotTimeout) {
				timedOut(request, options.gotTimeout, options);
			}

			emitter.emit('request', request);

			const uploadComplete = (): void => {
				request.emit('upload-complete');
			};

			try {
				if (is.nodeStream(options.body)) {
					options.body.once('end', uploadComplete);
					options.body.pipe(request);
					options.body = undefined;
				} else if (options.body) {
					request.end(options.body, uploadComplete);
				} else if (input && (options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH')) {
					input.once('end', uploadComplete);
					input.pipe(request);
				} else {
					request.end(uploadComplete);
				}
			} catch (error) {
				emitError(new RequestError(error, options));
			}
		};

		if (options.cache) {
			const cacheableRequest = new CacheableRequest(requestFn, options.cache);
			const cacheRequest = cacheableRequest(options as https.RequestOptions, handleResponse);

			cacheRequest.once('error', error => {
				if (error instanceof CacheableRequest.RequestError) {
					emitError(new RequestError(error, options));
				} else {
					emitError(new CacheError(error, options));
				}
			});

			cacheRequest.once('request', handleRequest);
		} else {
			// Catches errors thrown by calling requestFn(...)
			try {
				// @ts-ignore TS complains that URLSearchParams is not the same as URLSearchParams
				handleRequest(requestFn(options as any as URL, handleResponse));
			} catch (error) {
				emitError(new RequestError(error, options));
			}
		}
	};

	emitter.retry = (error): boolean => {
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
		} catch (error2) {
			emitError(error2);
			return false;
		}

		if (backoff) {
			const retry = async (options: NormalizedOptions): Promise<void> => {
				try {
					for (const hook of options.hooks.beforeRetry) {
						// eslint-disable-next-line no-await-in-loop
						await hook(options, error, retryCount);
					}

					await get(options);
				} catch (error) {
					emitError(error);
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

			// Serialize body
			const {body, headers} = options;
			const isForm = !is.nullOrUndefined(options.form);
			const isJSON = !is.nullOrUndefined(options.json);
			const isBody = !is.nullOrUndefined(body);
			if ((isBody || isForm || isJSON) && withoutBody.has(options.method as WithoutBody)) {
				throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
			}

			if (isBody) {
				if (isForm || isJSON) {
					throw new TypeError('The `body` option cannot be used with the `json` option or `form` option');
				}

				if (is.object(body) && isFormData(body)) {
					// Special case for https://github.com/form-data/form-data
					headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
				} else if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body)) {
					throw new TypeError('The `body` option must be a stream.Readable, string, Buffer, Object or Array');
				}
			} else if (isForm) {
				if (!is.object(options.form)) {
					throw new TypeError('The `form` option must be an Object');
				}

				headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
				options.body = (new URLSearchParamsGlobal(options.form as Record<string, string>)).toString();
			} else if (isJSON) {
				headers['content-type'] = headers['content-type'] || 'application/json';
				options.body = JSON.stringify(options.json);
			}

			// Convert buffer to stream to receive upload progress events (#322)
			if (is.buffer(body)) {
				options.body = toReadableStream(body);
				uploadBodySize = body.length;
			} else {
				uploadBodySize = await getBodySize(options);
			}

			if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding'])) {
				if ((uploadBodySize! > 0 || options.method === 'PUT') && !is.undefined(uploadBodySize)) {
					headers['content-length'] = String(uploadBodySize);
				}
			}

			if (!options.stream && options.responseType === 'json' && is.undefined(headers.accept)) {
				options.headers.accept = 'application/json';
			}

			requestUrl = options.href || (new URLGlobal(options.path, format(options as UrlObject))).toString();

			await get(options);
		} catch (error) {
			emitError(error);
		}
	});

	return emitter;
};
