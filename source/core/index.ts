import {Duplex, Writable, Readable} from 'stream';
import {ReadStream} from 'fs';
import {URL, URLSearchParams} from 'url';
import {Socket} from 'net';
import * as http from 'http';
import {ClientRequest, RequestOptions, IncomingMessage, ServerResponse} from 'http';
import * as https from 'https';
import timer, {ClientRequestWithTimings, Timings, IncomingMessageWithTimings} from '@szmarczak/http-timer';
import * as CacheableRequest from 'cacheable-request';
import decompressResponse = require('decompress-response');
import {request as requestHttp} from 'http';
import {request as requestHttps} from 'https';
import http2wrapper = require('http2-wrapper');
import ResponseLike = require('responselike');
import is from '@sindresorhus/is';
import applyDestroyPatch from './utils/apply-destroy-patch';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import proxyEvents from './utils/proxy-events';
import timedOut, {TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import urlToOptions from './utils/url-to-options';
import WeakableMap from './utils/weakable-map';
import getBuffer from './utils/get-buffer';
import {isResponseOk} from './utils/is-response-ok';
import calculateRetryDelay from './calculate-retry-delay';
import type {OptionsInit, PromiseCookieJar, NativeRequestOptions, RetryOptions, RequestFunction} from './options';
import Options, {createNativeRequestOptions} from './options';
import type {Response} from './response';
import type {Delays} from './utils/timed-out';
import {
	RequestError,
	ReadError,
	MaxRedirectsError,
	HTTPError,
	TimeoutError,
	UploadError,
	CacheError
} from './errors';

export interface Progress {
	percent: number;
	transferred: number;
	total?: number;
}

type Error = NodeJS.ErrnoException;

const kRequest = Symbol('request');
const kResponseSize = Symbol('responseSize');
const kDownloadedSize = Symbol('downloadedSize');
const kBodySize = Symbol('bodySize');
const kUploadedSize = Symbol('uploadedSize');
const kServerResponsesPiped = Symbol('serverResponsesPiped');
const kUnproxyEvents = Symbol('unproxyEvents');
const kIsFromCache = Symbol('isFromCache');
const kCancelTimeouts = Symbol('cancelTimeouts');
const kStartedReading = Symbol('startedReading');
const kStopReading = Symbol('stopReading');
const kTriggerRead = Symbol('triggerRead');
const kBody = Symbol('body');
const kJobs = Symbol('jobs');
const kOriginalResponse = Symbol('originalResponse');
const kRetryTimeout = Symbol('retryTimeout');

const supportsBrotli = is.string(process.versions.brotli);

export const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface RequestEvents<T> {
	/**
	`request` event to get the request object of the request.

	 __Tip__: You can use `request` event to abort requests.

	@example
	```
	got.stream('https://github.com')
		.on('request', request => setTimeout(() => request.destroy(), 50));
	```
	*/
	on: ((name: 'request', listener: (request: http.ClientRequest) => void) => T)

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
}

function isClientRequest(clientRequest: unknown): clientRequest is ClientRequest {
	return is.object(clientRequest) && !('statusCode' in clientRequest);
}

export type CacheableRequestFunction = (
	options: string | URL | NativeRequestOptions,
	cb?: (response: ServerResponse | ResponseLike) => void
) => CacheableRequest.Emitter;

const cacheableStore = new WeakableMap<string | CacheableRequest.StorageAdapter, CacheableRequestFunction>();

const waitForOpenFile = async (file: ReadStream): Promise<void> => new Promise((resolve, reject) => {
	const onError = (error: Error): void => {
		reject(error);
	};

	// Node.js 12 has incomplete types
	if (!(file as any).pending) {
		resolve();
	}

	file.once('error', onError);
	file.once('ready', () => {
		file.off('error', onError);
		resolve();
	});
});

const redirectCodes: ReadonlySet<number> = new Set([300, 301, 302, 303, 304, 307, 308]);

const proxiedRequestEvents = [
	'socket',
	'connect',
	'continue',
	'information',
	'upgrade',
	'timeout'
];

const getComputedRequest = (options: Options): RequestFunction => {
	const url = options.url as (URL | undefined);
	const {request} = options;

	if (!request && url) {
		if (url.protocol === 'https:') {
			if (options.http2) {
				return http2wrapper.auto as RequestFunction;
			}

			return requestHttps as RequestFunction;
		} else {
			return requestHttp as RequestFunction;
		}
	}

	return request as RequestFunction;
};

export default class Request extends Duplex implements RequestEvents<Request> {
	['constructor']: typeof Request;

	declare [kUnproxyEvents]: () => void;
	declare _cannotHaveBody: boolean;
	[kDownloadedSize]: number;
	[kUploadedSize]: number;
	[kStopReading]: boolean;
	[kTriggerRead]: boolean;
	[kBody]: Options['body'];
	[kJobs]: Array<() => void>;
	[kRetryTimeout]?: NodeJS.Timeout;
	[kBodySize]?: number;
	[kServerResponsesPiped]: Set<ServerResponse>;
	[kIsFromCache]?: boolean;
	[kStartedReading]?: boolean;
	[kCancelTimeouts]?: () => void;
	[kResponseSize]?: number;
	response?: IncomingMessageWithTimings;
	[kOriginalResponse]?: IncomingMessageWithTimings;
	[kRequest]?: ClientRequest;
	_noPipe?: boolean;

	// @ts-expect-error TypeScript bug.
	options: Options;
	declare requestUrl: string;
	requestInitialized: boolean;
	redirects: string[];
	retryCount: number;

	declare _requestOptions: NativeRequestOptions;

	constructor(url: string | URL | undefined, options?: OptionsInit) {
		super({
			// This must be false, to enable throwing after destroy
			// It is used for retry logic in Promise API
			autoDestroy: false,
			// It needs to be zero because we're just proxying the data to another stream
			highWaterMark: 0
		});

		// TODO: Remove this when targeting Node.js 14
		applyDestroyPatch(this);

		this[kDownloadedSize] = 0;
		this[kUploadedSize] = 0;
		this.requestInitialized = false;
		this[kServerResponsesPiped] = new Set<ServerResponse>();
		this.redirects = [];
		this[kStopReading] = false;
		this[kTriggerRead] = false;
		this[kJobs] = [];
		this.retryCount = 0;

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
			if (source instanceof IncomingMessage) {
				this.options.headers = {
					...source.headers,
					...this.options.headers
				};
			}
		});

		try {
			this.options = new Options(url, options);
		} catch (error) {
			this.destroy(error);
			return;
		}

		(async () => {
			try {
				// @ts-expect-error TypeScript bug.
				if (this.options.body instanceof ReadStream) {
					// @ts-expect-error TypeScript bug.
					await waitForOpenFile(this.options.body);
				}

				// @ts-expect-error TypeScript bug.
				const {url: normalizedURL} = this.options;

				if (!normalizedURL) {
					throw new TypeError('Missing `url` property');
				}

				this.requestUrl = normalizedURL.toString();
				decodeURI(this.requestUrl);

				await this._finalizeBody();
				await this._makeRequest();

				if (this.destroyed) {
					this[kRequest]?.destroy();
					return;
				}

				// Queued writes etc.
				for (const job of this[kJobs]) {
					job();
				}

				// Prevent memory leak
				this[kJobs].length = 0;

				this.requestInitialized = true;
			} catch (error) {
				if (error instanceof RequestError) {
					this._beforeError(error);
					return;
				}

				// This is a workaround for https://github.com/nodejs/node/issues/33335
				if (!this.destroyed) {
					this.destroy(error);
				}
			}
		})();
	}

	_lockWrite(): void {
		const onLockedWrite = (): never => {
			throw new TypeError('The payload has been already provided');
		};

		this.write = onLockedWrite;
		this.end = onLockedWrite;
	}

	_unlockWrite(): void {
		this.write = super.write;
		this.end = super.end;
	}

	async _finalizeBody(): Promise<void> {
		const {options} = this;
		const {headers} = options;

		const isForm = !is.undefined(options.form);
		const isJSON = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		const hasPayload = isForm || isJSON || isBody;
		const cannotHaveBody = withoutBody.has(options.method) && !(options.method === 'GET' && options.allowGetBody);

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

					this[kBody] = options.body;
				} else if (isForm) {
					if (noContentType) {
						headers['content-type'] = 'application/x-www-form-urlencoded';
					}

					this[kBody] = (new URLSearchParams(options.form as Record<string, string>)).toString();
				} else {
					if (noContentType) {
						headers['content-type'] = 'application/json';
					}

					this[kBody] = options.stringifyJson(options.json);
				}

				const uploadBodySize = await getBodySize(this[kBody], options.headers);

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

		this[kBodySize] = Number(headers['content-length']) || undefined;
	}

	async _onResponseBase(response: IncomingMessageWithTimings): Promise<void> {
		const {options} = this;
		const {url} = options;

		this[kOriginalResponse] = response;

		if (options.decompress) {
			response = decompressResponse(response);
		}

		const statusCode = response.statusCode!;
		const typedResponse = response as Response;

		typedResponse.statusMessage = typedResponse.statusMessage ? typedResponse.statusMessage : http.STATUS_CODES[statusCode];
		typedResponse.url = options.url!.toString();
		typedResponse.requestUrl = this.requestUrl;
		typedResponse.redirectUrls = this.redirects;
		typedResponse.request = this;
		typedResponse.isFromCache = (response as any).fromCache ?? false;
		typedResponse.ip = this.ip;
		typedResponse.retryCount = this.retryCount;

		this[kIsFromCache] = typedResponse.isFromCache;

		this[kResponseSize] = Number(response.headers['content-length']) || undefined;
		this.response = response;

		response.once('end', () => {
			this[kResponseSize] = this[kDownloadedSize];
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

		if (options.followRedirect && response.headers.location && redirectCodes.has(statusCode)) {
			// We're being redirected, we don't care about the response.
			// It'd be best to abort the request, but we can't because
			// we would have to sacrifice the TCP connection. We don't want that.
			response.resume();

			if (this[kRequest]) {
				this[kCancelTimeouts]!();

				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete this[kRequest];
				this[kUnproxyEvents]();
			}

			const shouldBeGet = statusCode === 303 && options.method !== 'GET' && options.method !== 'HEAD';
			if (shouldBeGet || options.methodRewriting) {
				// Server responded with "see other", indicating that the resource exists at another location,
				// and the client should request it from that location via GET or HEAD.
				options.method = 'GET';

				options.body = undefined;
				options.json = undefined;
				options.form = undefined;

				this[kBody] = undefined;
				delete options.headers['content-length'];
			}

			if (this.redirects.length >= options.maxRedirects) {
				this._beforeError(new MaxRedirectsError(this));
				return;
			}

			try {
				// Do not remove. See https://github.com/sindresorhus/got/pull/214
				const redirectBuffer = Buffer.from(response.headers.location, 'binary').toString();

				// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
				const redirectUrl = new URL(redirectBuffer, url);
				const redirectString = redirectUrl.toString();
				decodeURI(redirectString);

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

				this.redirects.push(redirectString);
				options.url = redirectUrl;

				for (const hook of options.hooks!.beforeRedirect) {
					// eslint-disable-next-line no-await-in-loop
					await hook(options, typedResponse);
				}

				this.emit('redirect', typedResponse, options);

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
			if (this[kTriggerRead]) {
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

		this.emit('response', response);

		for (const destination of this[kServerResponsesPiped]) {
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

	async _onResponse(response: IncomingMessageWithTimings): Promise<void> {
		try {
			await this._onResponseBase(response);
		} catch (error) {
			/* istanbul ignore next: better safe than sorry */
			this._beforeError(error);
		}
	}

	_onRequest(request: ClientRequest): void {
		const {options} = this;
		const {timeout, url} = options;

		timer(request);

		this[kCancelTimeouts] = timedOut(request, timeout as Delays, url as URL);

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

		this[kUnproxyEvents] = proxyEvents(request, this, proxiedRequestEvents);

		this[kRequest] = request;

		this.emit('uploadProgress', this.uploadProgress);

		// Send body
		const body = this[kBody];
		const currentRequest = this.redirects.length === 0 ? this : request;

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

	async _createCacheableRequest(url: URL, options: RequestOptions): Promise<ClientRequest | ResponseLike> {
		return new Promise<ClientRequest | ResponseLike>((resolve, reject) => {
			// TODO: Remove `utils/url-to-options.ts` when `cacheable-request` is fixed
			Object.assign(options, urlToOptions(url));

			// `http-cache-semantics` checks this
			delete (options as unknown as Options).url;

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

			// Restore options
			(options as unknown as Options).url = url;

			cacheRequest.once('error', reject);
			cacheRequest.once('request', async (requestOrPromise: ClientRequest | Promise<ClientRequest>) => {
				request = requestOrPromise;
				resolve(request);
			});
		});
	}

	async _makeRequest(): Promise<void> {
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

		let request = getComputedRequest(options);

		for (const hook of options.hooks!.beforeRequest) {
			// eslint-disable-next-line no-await-in-loop
			const result = await hook(options);

			if (!is.undefined(result)) {
				// @ts-expect-error Skip the type mismatch to support abstract responses
				request = () => result;
				break;
			}
		}

		if (options.body && this[kBody] !== options.body) {
			this[kBody] = options.body;
		}

		const url = options.url as URL;

		this._requestOptions = createNativeRequestOptions(options);

		// Cache support
		const fn = options.cache ? this._createCacheableRequest : request;

		try {
			let requestOrResponse = await fn!(url, this._requestOptions);

			// Fallback
			if (is.undefined(requestOrResponse)) {
				if (options.http2) {
					requestOrResponse = await http2wrapper.auto(url, this._requestOptions as http2wrapper.AutoRequestOptions);
				} else {
					const fallbackFn = url.protocol === 'https:' ? https.request : http.request;
					requestOrResponse = fallbackFn(url, this._requestOptions);
				}
			}

			if (isClientRequest(requestOrResponse)) {
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

			throw new RequestError(error.message, error, this);
		}
	}

	async _error(error: RequestError): Promise<void> {
		try {
			for (const hook of this.options.hooks!.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}
		} catch (error_) {
			error = new RequestError(error_.message, error_, this);
		}

		this.destroy(error);
	}

	_beforeError(error: Error): void {
		if (this[kStopReading]) {
			return;
		}

		const {options} = this;
		const retryCount = this.retryCount + 1;

		this[kStopReading] = true;

		if (!(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		const typedError = error as RequestError;
		const {response} = typedError;

		void (async () => {
			if (response && !response.body) {
				response.setEncoding((this as any)._readableState.encoding);

				try {
					response.rawBody = await getBuffer(response);
					response.body = response.rawBody.toString();
				} catch {}
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
						attemptCount: retryCount,
						retryOptions,
						error: typedError,
						retryAfter,
						computedValue: calculateRetryDelay({
							attemptCount: retryCount,
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
					const retry = async (): Promise<void> => {
						try {
							for (const hook of this.options.hooks!.beforeRetry) {
								// eslint-disable-next-line no-await-in-loop
								await hook(this.options, typedError, retryCount);
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
						this.emit('retry', retryCount, error);
					};

					this[kRetryTimeout] = setTimeout(retry, backoff);
					return;
				}
			}

			void this._error(typedError);
		})();
	}

	_read(): void {
		this[kTriggerRead] = true;

		const {response} = this;
		if (response && !this[kStopReading]) {
			// We cannot put this in the `if` above
			// because `.read()` also triggers the `end` event
			if (response.readableLength) {
				this[kTriggerRead] = false;
			}

			let data;
			while ((data = response.read()) !== null) {
				this[kDownloadedSize] += data.length;
				this[kStartedReading] = true;

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

		if (this.requestInitialized) {
			write();
		} else {
			this[kJobs].push(write);
		}
	}

	_writeRequest(chunk: any, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void {
		if (this[kRequest]!.destroyed) {
			// Probably the `ClientRequest` instance will throw
			return;
		}

		// TODO: What happens if it's from cache? Then this[kRequest] won't be defined.

		this[kRequest]!.write(chunk, encoding!, (error?: Error | null) => {
			if (!error) {
				this[kUploadedSize] += Buffer.byteLength(chunk, encoding);

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
			// We need to check if `this[kRequest]` is present,
			// because it isn't when we use cache.
			if (!(kRequest in this)) {
				callback();
				return;
			}

			if (this[kRequest]!.destroyed) {
				callback();
				return;
			}

			this[kRequest]!.end((error?: Error | null) => {
				if (!error) {
					this[kBodySize] = this[kUploadedSize];

					this.emit('uploadProgress', this.uploadProgress);
					this[kRequest]!.emit('upload-complete');
				}

				callback(error);
			});
		};

		if (this.requestInitialized) {
			endRequest();
		} else {
			this[kJobs].push(endRequest);
		}
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this[kStopReading] = true;

		// Prevent further retries
		clearTimeout(this[kRetryTimeout]!);

		const {body} = this.options;
		if (is.nodeStream(body)) {
			body.destroy();
		}

		if (kRequest in this) {
			this[kCancelTimeouts]!();

			// TODO: Remove the next `if` when targeting Node.js 14.
			if (!this.response?.complete) {
				this[kRequest]!.destroy();
			}
		}

		if (error !== null && !is.undefined(error) && !(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		callback(error);
	}

	get _isAboutToError() {
		return this[kStopReading];
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
	get aborted(): boolean {
		return (this[kRequest]?.destroyed ?? this.destroyed) && !(this[kOriginalResponse]?.complete);
	}

	get socket(): Socket | undefined {
		return this[kRequest]?.socket ?? undefined;
	}

	/**
	Progress event for downloading (receiving a response).
	*/
	get downloadProgress(): Progress {
		let percent;
		if (this[kResponseSize]) {
			percent = this[kDownloadedSize] / this[kResponseSize]!;
		} else if (this[kResponseSize] === this[kDownloadedSize]) {
			percent = 1;
		} else {
			percent = 0;
		}

		return {
			percent,
			transferred: this[kDownloadedSize],
			total: this[kResponseSize]
		};
	}

	/**
	Progress event for uploading (sending a request).
	*/
	get uploadProgress(): Progress {
		let percent;
		if (this[kBodySize]) {
			percent = this[kUploadedSize] / this[kBodySize]!;
		} else if (this[kBodySize] === this[kUploadedSize]) {
			percent = 1;
		} else {
			percent = 0;
		}

		return {
			percent,
			transferred: this[kUploadedSize],
			total: this[kBodySize]
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
		return (this[kRequest] as ClientRequestWithTimings)?.timings;
	}

	/**
	Whether the response was retrieved from the cache.
	*/
	get isFromCache(): boolean | undefined {
		return this[kIsFromCache];
	}

	pipe<T extends NodeJS.WritableStream>(destination: T, options?: {end?: boolean}): T {
		if (this[kStartedReading]) {
			throw new Error('Failed to pipe. The response has been emitted already.');
		}

		if (destination instanceof ServerResponse) {
			this[kServerResponsesPiped].add(destination);
		}

		return super.pipe(destination, options);
	}

	unpipe<T extends NodeJS.WritableStream>(destination: T): this {
		if (destination instanceof ServerResponse) {
			this[kServerResponsesPiped].delete(destination);
		}

		super.unpipe(destination);

		return this;
	}
}
