import {Duplex, Writable, Readable} from 'stream';
import {URL, URLSearchParams} from 'url';
import * as http from 'http';
import {ServerResponse} from 'http';
import timer from '@szmarczak/http-timer';
import * as CacheableRequest from 'cacheable-request';
import decompressResponse = require('decompress-response');
import is from '@sindresorhus/is';
import applyDestroyPatch from './utils/apply-destroy-patch';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import proxyEvents from './utils/proxy-events';
import timedOut, {TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import urlToOptions from './utils/url-to-options';
import WeakableMap from './utils/weakable-map';
import {buffer as getBuffer} from 'get-stream';
import calculateRetryDelay from './calculate-retry-delay';
import Options from './options';
import {isResponseOk} from './response';
import isClientRequest from './utils/is-client-request';
import {
	RequestError,
	ReadError,
	MaxRedirectsError,
	HTTPError,
	TimeoutError,
	UploadError,
	CacheError
} from './errors';
import type {ClientRequestWithTimings, Timings, IncomingMessageWithTimings} from '@szmarczak/http-timer';
import type {ClientRequest, RequestOptions, IncomingMessage} from 'http';
import type {Socket} from 'net';
import type ResponseLike = require('responselike');
import type {PlainResponse} from './response';
import type {OptionsInit, PromiseCookieJar, NativeRequestOptions, RetryOptions} from './options';
import type {CancelableRequest} from '../as-promise';

export interface Progress {
	percent: number;
	transferred: number;
	total?: number;
}

type Error = NodeJS.ErrnoException;

const supportsBrotli = is.string(process.versions.brotli);

export const methodsWithoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export type GotEventFunction<T> =
	/**
	`request` event to get the request object of the request.

	 __Tip__: You can use `request` event to abort requests.

	@example
	```
	got.stream('https://github.com')
		.on('request', request => setTimeout(() => request.destroy(), 50));
	```
	*/
	((name: 'request', listener: (request: ClientRequest) => void) => T)

	/**
	The `response` event to get the response object of the final request.
	*/
	& (<R extends Response>(name: 'response', listener: (response: R) => void) => T)

	/**
	The `redirect` event to get the response object of a redirect. The second argument is options for the next request to the redirect location.
	*/
	& (<R extends Response, N extends Options>(name: 'redirect', listener: (response: R, nextOptions: N) => void) => T)

	/**
	Progress events for uploading (sending a request) and downloading (receiving a response).
	The `progress` argument is an object like:

	```js
	{
		percent: 0.1,
		transferred: 1024,
		total: 10240
	}
	```

	If the `content-length` header is missing, `total` will be `undefined`.

	@example
	```js
	(async () => {
		const response = await got('https://sindresorhus.com')
			.on('downloadProgress', progress => {
				// Report download progress
			})
			.on('uploadProgress', progress => {
				// Report upload progress
			});

		console.log(response);
	})();
	```
	*/
	& ((name: 'uploadProgress' | 'downloadProgress', listener: (progress: Progress) => void) => T)
	/**
	To enable retrying on a Got stream, it is required to have a `retry` handler attached.

	When this event is emitted, you should reset the stream you were writing to and prepare the body again.

	See `got.options.retry` for more information.
	*/
	& ((name: 'retry', listener: (retryCount: number, error: RequestError) => void) => T);

export interface RequestEvents<T> {
	on: GotEventFunction<T>;
	once: GotEventFunction<T>;
}

export type CacheableRequestFunction = (
	options: string | URL | NativeRequestOptions,
	cb?: (response: ServerResponse | ResponseLike) => void
) => CacheableRequest.Emitter;

const cacheableStore = new WeakableMap<string | CacheableRequest.StorageAdapter, CacheableRequestFunction>();

const redirectCodes: ReadonlySet<number> = new Set([300, 301, 302, 303, 304, 307, 308]);

const proxiedRequestEvents = [
	'socket',
	'connect',
	'continue',
	'information',
	'upgrade'
];

const noop = () => {};

export default class Request extends Duplex implements RequestEvents<Request> {
	['constructor']: typeof Request;

	_noPipe?: boolean;
	_promise?: CancelableRequest;

	// @ts-expect-error TypeScript doesn't check try/catch inside constructors. Dang.
	options: Options;
	response?: PlainResponse;
	requestUrl?: URL;
	redirectUrls: URL[];
	retryCount: number;

	declare private _requestOptions: NativeRequestOptions;

	private _stopRetry: () => void;
	private _downloadedSize: number;
	private _uploadedSize: number;
	private _stopReading: boolean;
	private _startedReading: boolean;
	private readonly _pipedServerResponses: Set<ServerResponse>;
	private _request?: ClientRequest;
	private _responseSize?: number;
	private _bodySize?: number;
	private _unproxyEvents: () => void;
	private _isFromCache?: boolean;
	private _cannotHaveBody: boolean;
	private _triggerRead: boolean;
	declare private _jobs: Array<() => void>;
	private _cancelTimeouts: () => void;
	private _nativeResponse?: IncomingMessageWithTimings;
	private _staticBody: Options['body'];
	private _flushed: boolean;

	constructor(url: string | URL | OptionsInit | Options | undefined, options?: OptionsInit | Options, defaults?: Options) {
		super({
			// Don't destroy immediately, as the error may be emitted on unsuccessful retry
			autoDestroy: false,
			// It needs to be zero because we're just proxying the data to another stream
			highWaterMark: 0
		});

		// TODO: Remove this when targeting Node.js 14
		applyDestroyPatch(this);

		this._downloadedSize = 0;
		this._uploadedSize = 0;
		this._stopReading = false;
		this._startedReading = false;
		this._pipedServerResponses = new Set<ServerResponse>();
		this._cannotHaveBody = false;
		this._unproxyEvents = noop;
		this._triggerRead = false;
		this._cancelTimeouts = noop;
		this._jobs = [];
		this._flushed = false;

		this.redirectUrls = [];
		this.retryCount = 0;

		this._stopRetry = noop;

		const unlockWrite = (): void => {
			this._unlockWrite();
		};

		const lockWrite = (): void => {
			this._lockWrite();
		};

		this.on('pipe', (source: Writable) => {
			source.prependListener('data', unlockWrite);
			source.on('data', lockWrite);

			source.prependListener('end', unlockWrite);
			source.on('end', lockWrite);
		});

		this.on('unpipe', (source: Writable) => {
			source.off('data', unlockWrite);
			source.off('data', lockWrite);

			source.off('end', unlockWrite);
			source.off('end', lockWrite);
		});

		this.on('pipe', source => {
			if (source.headers) {
				Object.assign(this.options.headers, source.headers);
			}
		});

		try {
			this.options = new Options(url, options, defaults);

			const {url: normalizedURL} = this.options;

			if (!normalizedURL) {
				throw new TypeError('Missing `url` property');
			}

			this.requestUrl = normalizedURL as URL;
		} catch (error) {
			this.flush = async () => {
				this.destroy(error);
			};

			return;
		}

		// Important! If you replace `body` in a handler with another stream, make sure it's readable first.
		// The below is run only once.
		const {body} = this.options;
		if (is.nodeStream(body)) {
			body.once('error', error => {
				if (this._flushed) {
					this._beforeError(new RequestError(error.message, error, this));
				} else {
					this.flush = async () => {
						this._beforeError(new RequestError(error.message, error, this));
					};
				}
			});
		}
	}

	async flush() {
		if (this._flushed) {
			throw new Error('Request has been already flushed');
		}

		this._flushed = true;

		try {
			await this._finalizeBody();

			if (this.destroyed) {
				return;
			}

			await this._makeRequest();

			if (this.destroyed) {
				this._request?.destroy();
				return;
			}

			// Queued writes etc.
			for (const job of this._jobs) {
				job();
			}

			// Prevent memory leak
			this._jobs.length = 0;
		} catch (error) {
			if (error instanceof RequestError) {
				this._beforeError(error);
				return;
			}

			this._beforeError(new RequestError(error.message, error, this));
		}
	}

	private _lockWrite(): void {
		const onLockedWrite = (): never => {
			throw new TypeError('The payload has been already provided');
		};

		this.write = onLockedWrite;
		this.end = onLockedWrite;
	}

	private _unlockWrite(): void {
		this.write = super.write;
		this.end = super.end;
	}

	private async _finalizeBody(): Promise<void> {
		const {options} = this;
		const {headers} = options;

		const isForm = !is.undefined(options.form);
		const isJSON = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		const hasPayload = isForm || isJSON || isBody;
		const cannotHaveBody = methodsWithoutBody.has(options.method) && !(options.method === 'GET' && options.allowGetBody);

		this._cannotHaveBody = cannotHaveBody;

		if (hasPayload) {
			if (cannotHaveBody) {
				throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
			}

			if ([isBody, isForm, isJSON].filter(isTrue => isTrue).length > 1) {
				throw new TypeError('The `body`, `json` and `form` options are mutually exclusive');
			}

			if (
				isBody &&
				!(options.body instanceof Readable) &&
				!is.string(options.body) &&
				!is.buffer(options.body) &&
				!isFormData(options.body)
			) {
				throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
			}

			if (isForm && !is.object(options.form)) {
				throw new TypeError('The `form` option must be an Object');
			}

			{
				// Serialize body
				const noContentType = !is.string(headers['content-type']);

				if (isBody) {
					// Special case for https://github.com/form-data/form-data
					if (isFormData(options.body) && noContentType) {
						headers['content-type'] = `multipart/form-data; boundary=${options.body.getBoundary()}`;
					}

					this._staticBody = options.body;
				} else if (isForm) {
					if (noContentType) {
						headers['content-type'] = 'application/x-www-form-urlencoded';
					}

					this._staticBody = (new URLSearchParams(options.form as Record<string, string>)).toString();
				} else {
					if (noContentType) {
						headers['content-type'] = 'application/json';
					}

					this._staticBody = options.stringifyJson(options.json);
				}

				const uploadBodySize = await getBodySize(this._staticBody, options.headers);

				// See https://tools.ietf.org/html/rfc7230#section-3.3.2
				// A user agent SHOULD send a Content-Length in a request message when
				// no Transfer-Encoding is sent and the request method defines a meaning
				// for an enclosed payload body.  For example, a Content-Length header
				// field is normally sent in a POST request even when the value is 0
				// (indicating an empty payload body).  A user agent SHOULD NOT send a
				// Content-Length header field when the request message does not contain
				// a payload body and the method semantics do not anticipate such a
				// body.
				if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding']) && !cannotHaveBody && !is.undefined(uploadBodySize)) {
					headers['content-length'] = String(uploadBodySize);
				}
			}
		} else if (cannotHaveBody) {
			this._lockWrite();
		} else {
			this._unlockWrite();
		}

		this._bodySize = Number(headers['content-length']) || undefined;
	}

	private async _onResponseBase(response: IncomingMessageWithTimings): Promise<void> {
		// This will be called e.g. when using cache so we need to check if this request has been aborted.
		if (this.isAborted) {
			return;
		}

		const {options} = this;
		const {url} = options;

		this._nativeResponse = response;

		if (options.decompress) {
			response = decompressResponse(response);
		}

		const statusCode = response.statusCode!;
		const typedResponse = response as PlainResponse;

		typedResponse.statusMessage = typedResponse.statusMessage ? typedResponse.statusMessage : http.STATUS_CODES[statusCode];
		typedResponse.url = options.url!.toString();
		typedResponse.requestUrl = this.requestUrl!;
		typedResponse.redirectUrls = this.redirectUrls;
		typedResponse.request = this;
		typedResponse.isFromCache = (response as any).fromCache ?? false;
		typedResponse.ip = this.ip;
		typedResponse.retryCount = this.retryCount;

		this._isFromCache = typedResponse.isFromCache;

		this._responseSize = Number(response.headers['content-length']) || undefined;
		this.response = typedResponse;

		response.once('end', () => {
			this._responseSize = this._downloadedSize;
			this.emit('downloadProgress', this.downloadProgress);
		});

		response.once('error', (error: Error) => {
			// Force clean-up, because some packages don't do this.
			// TODO: Fix decompress-response
			response.destroy();

			this._beforeError(new ReadError(error, this));
		});

		response.once('aborted', () => {
			this._beforeError(new ReadError({
				name: 'Error',
				message: 'The server aborted pending request',
				code: 'ECONNRESET'
			}, this));
		});

		this.emit('downloadProgress', this.downloadProgress);

		const rawCookies = response.headers['set-cookie'];
		if (is.object(options.cookieJar) && rawCookies) {
			let promises: Array<Promise<unknown>> = rawCookies.map(async (rawCookie: string) => {
				return (options.cookieJar as PromiseCookieJar).setCookie(rawCookie, url!.toString());
			});

			if (options.ignoreInvalidCookies) {
				promises = promises.map(async p => p.catch(() => {}));
			}

			try {
				await Promise.all(promises);
			} catch (error) {
				this._beforeError(error);
				return;
			}
		}

		// The above is running a promise, therefore we need to check if this request has been aborted yet again.
		if (this.isAborted) {
			return;
		}

		if (options.followRedirect && response.headers.location && redirectCodes.has(statusCode)) {
			// We're being redirected, we don't care about the response.
			// It'd be best to abort the request, but we can't because
			// we would have to sacrifice the TCP connection. We don't want that.
			response.resume();

			this._cancelTimeouts();
			this._unproxyEvents();

			this._request = undefined;

			const shouldBeGet = statusCode === 303 && options.method !== 'GET' && options.method !== 'HEAD';
			if (shouldBeGet || options.methodRewriting) {
				// Server responded with "see other", indicating that the resource exists at another location,
				// and the client should request it from that location via GET or HEAD.
				options.method = 'GET';

				options.body = undefined;
				options.json = undefined;
				options.form = undefined;

				this._staticBody = undefined;
				delete options.headers['content-length'];
			}

			if (this.redirectUrls.length >= options.maxRedirects) {
				this._beforeError(new MaxRedirectsError(this));
				return;
			}

			try {
				// We need this in order to support UTF-8
				const redirectBuffer = Buffer.from(response.headers.location, 'binary').toString();

				// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
				const redirectUrl = new URL(redirectBuffer, url);

				// Redirecting to a different site, clear sensitive data.
				if (redirectUrl.hostname !== (url as URL).hostname || redirectUrl.port !== (url as URL).port) {
					if ('host' in options.headers) {
						delete options.headers.host;
					}

					if ('cookie' in options.headers) {
						delete options.headers.cookie;
					}

					if ('authorization' in options.headers) {
						delete options.headers.authorization;
					}

					if (options.username || options.password) {
						options.username = '';
						options.password = '';
					}
				} else {
					redirectUrl.username = options.username;
					redirectUrl.password = options.password;
				}

				this.redirectUrls.push(redirectUrl);
				options.url = redirectUrl;

				for (const hook of options.hooks.beforeRedirect) {
					// eslint-disable-next-line no-await-in-loop
					await hook(typedResponse);
				}

				this.emit('redirect', typedResponse);

				await this._makeRequest();
			} catch (error) {
				this._beforeError(error);
				return;
			}

			return;
		}

		if (options.isStream && options.throwHttpErrors && !isResponseOk(typedResponse)) {
			this._beforeError(new HTTPError(typedResponse));
			return;
		}

		response.on('readable', () => {
			if (this._triggerRead) {
				this._read();
			}
		});

		this.on('resume', () => {
			response.resume();
		});

		this.on('pause', () => {
			response.pause();
		});

		response.once('end', () => {
			this.push(null);
		});

		if (this._noPipe) {
			const success = await this._setRawBody();

			if (success) {
				this.emit('response', response);
			}

			return;
		}

		this.emit('response', response);

		for (const destination of this._pipedServerResponses) {
			if (destination.headersSent) {
				continue;
			}

			// eslint-disable-next-line guard-for-in
			for (const key in response.headers) {
				const isAllowed = options.decompress ? key !== 'content-encoding' : true;
				const value = response.headers[key];

				if (isAllowed) {
					destination.setHeader(key, value!);
				}
			}

			destination.statusCode = statusCode;
		}
	}

	private async _setRawBody(from: Readable = this): Promise<boolean> {
		try {
			// Errors are emitted via the `error` event
			const rawBody = await getBuffer(from);

			// On retry Request is destroyed with no error, therefore the above will successfully resolve.
			// So in order to check if this was really successfull, we need to check if it has been properly ended.
			if (from.readableEnded) {
				this.response!.rawBody = rawBody;

				return true;
			}
		} catch {}

		return false;
	}

	private async _onResponse(response: IncomingMessageWithTimings): Promise<void> {
		try {
			await this._onResponseBase(response);
		} catch (error) {
			/* istanbul ignore next: better safe than sorry */
			this._beforeError(error);
		}
	}

	private _onRequest(request: ClientRequest): void {
		const {options} = this;
		const {timeout, url} = options;

		timer(request);

		this._cancelTimeouts = timedOut(request, timeout, url as URL);

		const responseEventName = options.cache ? 'cacheableResponse' : 'response';

		request.once(responseEventName, (response: IncomingMessageWithTimings) => {
			void this._onResponse(response);
		});

		request.once('error', (error: Error) => {
			// Force clean-up, because some packages (e.g. nock) don't do this.
			request.destroy();

			// Node.js <= 12.18.2 mistakenly emits the response `end` first.
			(request as ClientRequest & {res: IncomingMessage | undefined}).res?.removeAllListeners('end');

			error = error instanceof TimedOutTimeoutError ? new TimeoutError(error, this.timings!, this) : new RequestError(error.message, error, this);

			this._beforeError(error as RequestError);
		});

		this._unproxyEvents = proxyEvents(request, this, proxiedRequestEvents);

		this._request = request;

		this.emit('uploadProgress', this.uploadProgress);

		// Send body
		const body = this._staticBody;
		const currentRequest = this.redirectUrls.length === 0 ? this : request;

		if (is.nodeStream(body)) {
			body.pipe(currentRequest);
			body.once('error', (error: NodeJS.ErrnoException) => {
				this._beforeError(new UploadError(error, this));
			});
		} else {
			this._unlockWrite();

			if (!is.undefined(body)) {
				this._writeRequest(body, undefined, () => {});
				currentRequest.end();

				this._lockWrite();
			} else if (this._cannotHaveBody || this._noPipe) {
				currentRequest.end();

				this._lockWrite();
			}
		}

		this.emit('request', request);
	}

	private _prepareCache(cache: string | CacheableRequest.StorageAdapter) {
		if (!cacheableStore.has(cache)) {
			cacheableStore.set(cache, new CacheableRequest(
				((requestOptions: RequestOptions, handler?: (response: IncomingMessageWithTimings) => void): ClientRequest => {
					const result = (requestOptions as any)._request(requestOptions, handler);

					// TODO: remove this when `cacheable-request` supports async request functions.
					if (is.promise(result)) {
						// @ts-expect-error
						// We only need to implement the error handler in order to support HTTP2 caching.
						// The result will be a promise anyway.
						// eslint-disable-next-line @typescript-eslint/promise-function-async
						result.once = (event: string, handler: (reason: unknown) => void) => {
							if (event === 'error') {
								result.catch(handler);
							} else if (event === 'abort') {
								// The empty catch is needed here in case when
								// it rejects before it's `await`ed in `_makeRequest`.
								(async () => {
									try {
										const request = (await result) as ClientRequest;
										request.once('abort', handler);
									} catch {}
								})();
							} else {
								/* istanbul ignore next: safety check */
								throw new Error(`Unknown HTTP2 promise event: ${event}`);
							}

							return result;
						};
					}

					return result;
				}) as typeof http.request,
				cache as CacheableRequest.StorageAdapter
			));
		}
	}

	private async _createCacheableRequest(url: URL, options: RequestOptions): Promise<ClientRequest | ResponseLike> {
		return new Promise<ClientRequest | ResponseLike>((resolve, reject) => {
			// TODO: Remove `utils/url-to-options.ts` when `cacheable-request` is fixed
			Object.assign(options, urlToOptions(url));

			let request: ClientRequest | Promise<ClientRequest>;

			// This is ugly
			const cacheRequest = cacheableStore.get((options as any).cache)!(options, async response => {
				// TODO: Fix `cacheable-response`
				(response as any)._readableState.autoDestroy = false;

				if (request) {
					(await request).emit('cacheableResponse', response);
				}

				resolve(response as unknown as ResponseLike);
			});

			cacheRequest.once('error', reject);
			cacheRequest.once('request', async (requestOrPromise: ClientRequest | Promise<ClientRequest>) => {
				request = requestOrPromise;
				resolve(request);
			});
		});
	}

	private async _makeRequest(): Promise<void> {
		const {options} = this;
		const {headers} = options;
		const cookieJar = options.cookieJar as PromiseCookieJar | undefined;

		for (const key in headers) {
			if (is.undefined(headers[key])) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete headers[key];
			} else if (is.null_(headers[key])) {
				throw new TypeError(`Use \`undefined\` instead of \`null\` to delete the \`${key}\` header`);
			}
		}

		if (options.decompress && is.undefined(headers['accept-encoding'])) {
			headers['accept-encoding'] = supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate';
		}

		// Set cookies
		if (cookieJar) {
			const cookieString: string = await cookieJar.getCookieString(options.url!.toString());

			if (is.nonEmptyString(cookieString)) {
				headers.cookie = cookieString;
			}
		}

		let request = options.getRequestFunction();

		for (const hook of options.hooks.beforeRequest) {
			// eslint-disable-next-line no-await-in-loop
			const result = await hook(options);

			if (!is.undefined(result)) {
				// @ts-expect-error Skip the type mismatch to support abstract responses
				request = () => result;
				break;
			}
		}

		if (options.body && this._staticBody !== options.body) {
			this._staticBody = options.body;
		}

		const url = options.url as URL;

		this._requestOptions = options.createNativeRequestOptions();

		if (options.cache) {
			(this._requestOptions as any)._request = request;
			this._prepareCache(options.cache as CacheableRequest.StorageAdapter);
		}

		// Cache support
		const fn = options.cache ? this._createCacheableRequest : request;

		try {
			let requestOrResponse = await fn(url, this._requestOptions);

			// Fallback
			if (is.undefined(requestOrResponse)) {
				requestOrResponse = await options.getFallbackRequestFunction()(url, this._requestOptions);
			}

			if (isClientRequest(requestOrResponse!)) {
				this._onRequest(requestOrResponse);
			} else if (this.writable) {
				this.once('finish', () => {
					void this._onResponse(requestOrResponse as IncomingMessageWithTimings);
				});

				this._unlockWrite();
				this.end();
				this._lockWrite();
			} else {
				void this._onResponse(requestOrResponse as IncomingMessageWithTimings);
			}
		} catch (error) {
			if (error instanceof CacheableRequest.CacheError) {
				throw new CacheError(error, this);
			}

			throw error;
		}
	}

	private async _error(error: RequestError): Promise<void> {
		try {
			for (const hook of this.options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}
		} catch (error_) {
			error = new RequestError(error_.message, error_, this);
		}

		this.destroy(error);
	}

	_beforeError(error: Error): void {
		if (this._stopReading) {
			return;
		}

		const {response, options} = this;
		const attemptCount = this.retryCount + (error.name === 'RetryError' ? 0 : 1);

		this._stopReading = true;

		if (!(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		const typedError = error as RequestError;

		void (async () => {
			if (response && !response.rawBody) {
				// @types/node has incorrect typings. `setEncoding` accepts `null` as well.
				response.setEncoding(this.readableEncoding!);

				const success = await this._setRawBody(response);

				if (success) {
					response.body = response.rawBody!.toString();
				}
			}

			if (this.listenerCount('retry') !== 0) {
				let backoff: number;

				try {
					let retryAfter;
					if (response && 'retry-after' in response.headers) {
						retryAfter = Number(response.headers['retry-after']);
						if (Number.isNaN(retryAfter)) {
							retryAfter = Date.parse(response.headers['retry-after']!) - Date.now();

							if (retryAfter <= 0) {
								retryAfter = 1;
							}
						} else {
							retryAfter *= 1000;
						}
					}

					const retryOptions = options.retry as RetryOptions;

					backoff = await retryOptions.calculateDelay({
						attemptCount,
						retryOptions,
						error: typedError,
						retryAfter,
						computedValue: calculateRetryDelay({
							attemptCount,
							retryOptions,
							error: typedError,
							retryAfter,
							computedValue: 0
						})
					});
				} catch (error_) {
					void this._error(new RequestError(error_.message, error_, this));
					return;
				}

				if (backoff) {
					await new Promise<void>(resolve => {
						const timeout = setTimeout(resolve);
						this._stopRetry = () => {
							clearTimeout(timeout);
							resolve();
						};
					});

					// Something forced us to abort the retry
					if (this.destroyed) {
						return;
					}

					try {
						for (const hook of this.options.hooks.beforeRetry) {
							// eslint-disable-next-line no-await-in-loop
							await hook(typedError);
						}
					} catch (error_) {
						void this._error(new RequestError(error_.message, error, this));
						return;
					}

					// Something forced us to abort the retry
					if (this.destroyed) {
						return;
					}

					this.destroy();
					this.emit('retry', error);
					return;
				}
			}

			void this._error(typedError);
		})();
	}

	_read(): void {
		this._triggerRead = true;

		const {response} = this;
		if (response && !this._stopReading) {
			// We cannot put this in the `if` above
			// because `.read()` also triggers the `end` event
			if (response.readableLength) {
				this._triggerRead = false;
			}

			let data;
			while ((data = response.read()) !== null) {
				this._downloadedSize += data.length;
				this._startedReading = true;

				const progress = this.downloadProgress;

				if (progress.percent < 1) {
					this.emit('downloadProgress', progress);
				}

				this.push(data);
			}
		}
	}

	// Node.js 12 has incorrect types, so the encoding must be a string
	_write(chunk: any, encoding: string | undefined, callback: (error?: Error | null) => void): void {
		const write = (): void => {
			this._writeRequest(chunk, encoding as BufferEncoding, callback);
		};

		if (this._request) {
			write();
		} else {
			this._jobs.push(write);
		}
	}

	private _writeRequest(chunk: any, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void {
		if (!this._request || this._request.destroyed) {
			// Probably the `ClientRequest` instance will throw
			return;
		}

		this._request.write(chunk, encoding!, (error?: Error | null) => {
			if (!error) {
				this._uploadedSize += Buffer.byteLength(chunk, encoding);

				const progress = this.uploadProgress;

				if (progress.percent < 1) {
					this.emit('uploadProgress', progress);
				}
			}

			callback(error);
		});
	}

	_final(callback: (error?: Error | null) => void): void {
		const endRequest = (): void => {
			// We need to check if `this._request` is present,
			// because it isn't when we use cache.
			if (!this._request || this._request.destroyed) {
				callback();
				return;
			}

			this._request.end((error?: Error | null) => {
				if (!error) {
					this._bodySize = this._uploadedSize;

					this.emit('uploadProgress', this.uploadProgress);
					this._request!.emit('upload-complete');
				}

				callback(error);
			});
		};

		if (this._request) {
			endRequest();
		} else {
			this._jobs.push(endRequest);
		}
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this._stopReading = true;

		// Prevent further retries
		this._stopRetry();
		this._cancelTimeouts();

		if (this.options) {
			const {body} = this.options;
			if (is.nodeStream(body)) {
				body.destroy();
			}
		}

		// TODO: Remove the next `if` when targeting Node.js 14.
		if (this._request && !this.response?.complete) {
			this._request.destroy();
		}

		if (error !== null && !is.undefined(error) && !(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		callback(error);
	}

	/**
	The remote IP address.
	*/
	get ip(): string | undefined {
		return this.socket?.remoteAddress;
	}

	/**
	Indicates whether the request has been aborted or not.
	*/
	get isAborted(): boolean {
		return (this._request?.destroyed ?? this.destroyed) && !(this._nativeResponse?.complete);
	}

	get socket(): Socket | undefined {
		return this._request?.socket ?? undefined;
	}

	/**
	Progress event for downloading (receiving a response).
	*/
	get downloadProgress(): Progress {
		let percent;
		if (this._responseSize) {
			percent = this._downloadedSize / this._responseSize;
		} else if (this._responseSize === this._downloadedSize) {
			percent = 1;
		} else {
			percent = 0;
		}

		return {
			percent,
			transferred: this._downloadedSize,
			total: this._responseSize
		};
	}

	/**
	Progress event for uploading (sending a request).
	*/
	get uploadProgress(): Progress {
		let percent;
		if (this._bodySize) {
			percent = this._uploadedSize / this._bodySize;
		} else if (this._bodySize === this._uploadedSize) {
			percent = 1;
		} else {
			percent = 0;
		}

		return {
			percent,
			transferred: this._uploadedSize,
			total: this._bodySize
		};
	}

	/**
	The object contains the following properties:

	- `start` - Time when the request started.
	- `socket` - Time when a socket was assigned to the request.
	- `lookup` - Time when the DNS lookup finished.
	- `connect` - Time when the socket successfully connected.
	- `secureConnect` - Time when the socket securely connected.
	- `upload` - Time when the request finished uploading.
	- `response` - Time when the request fired `response` event.
	- `end` - Time when the response fired `end` event.
	- `error` - Time when the request fired `error` event.
	- `abort` - Time when the request fired `abort` event.
	- `phases`
		- `wait` - `timings.socket - timings.start`
		- `dns` - `timings.lookup - timings.socket`
		- `tcp` - `timings.connect - timings.lookup`
		- `tls` - `timings.secureConnect - timings.connect`
		- `request` - `timings.upload - (timings.secureConnect || timings.connect)`
		- `firstByte` - `timings.response - timings.upload`
		- `download` - `timings.end - timings.response`
		- `total` - `(timings.end || timings.error || timings.abort) - timings.start`

	If something has not been measured yet, it will be `undefined`.

	__Note__: The time is a `number` representing the milliseconds elapsed since the UNIX epoch.
	*/
	get timings(): Timings | undefined {
		return (this._request as ClientRequestWithTimings)?.timings;
	}

	/**
	Whether the response was retrieved from the cache.
	*/
	get isFromCache(): boolean | undefined {
		return this._isFromCache;
	}

	get reusedSocket(): boolean | undefined {
		// @ts-expect-error `@types/node` has incomplete types
		return this._request.reusedSocket;
	}

	pipe<T extends NodeJS.WritableStream>(destination: T, options?: {end?: boolean}): T {
		if (this._startedReading) {
			throw new Error('Failed to pipe. The response has been emitted already.');
		}

		if (destination instanceof ServerResponse) {
			this._pipedServerResponses.add(destination);
		}

		return super.pipe(destination, options);
	}

	unpipe<T extends NodeJS.WritableStream>(destination: T): this {
		if (destination instanceof ServerResponse) {
			this._pipedServerResponses.delete(destination);
		}

		super.unpipe(destination);

		return this;
	}
}
