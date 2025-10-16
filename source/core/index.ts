import process from 'node:process';
import {Buffer} from 'node:buffer';
import {Duplex, Transform, type Readable, type TransformCallback} from 'node:stream';
import http, {ServerResponse, type ClientRequest, type RequestOptions} from 'node:http';
import type {Socket} from 'node:net';
import timer, {type ClientRequestWithTimings, type Timings, type IncomingMessageWithTimings} from '@szmarczak/http-timer';
import CacheableRequest, {
	CacheError as CacheableCacheError,
	type CacheableRequestFunction,
	type CacheableOptions,
} from 'cacheable-request';
import decompressResponse from 'decompress-response';
import type {KeyvStoreAdapter} from 'keyv';
import type KeyvType from 'keyv';
import is, {isBuffer} from '@sindresorhus/is';
import {FormDataEncoder, isFormData as isFormDataLike} from 'form-data-encoder';
import type ResponseLike from 'responselike';
import getBodySize from './utils/get-body-size.js';
import isFormData from './utils/is-form-data.js';
import proxyEvents from './utils/proxy-events.js';
import timedOut, {TimeoutError as TimedOutTimeoutError} from './timed-out.js';
import urlToOptions from './utils/url-to-options.js';
import WeakableMap from './utils/weakable-map.js';
import calculateRetryDelay from './calculate-retry-delay.js';
import Options, {
	type PromiseCookieJar,
	type NativeRequestOptions,
	type RetryOptions,
	type OptionsError,
	type OptionsInit,
	type NormalizedOptions,
} from './options.js';
import {isResponseOk, type PlainResponse, type Response} from './response.js';
import isClientRequest from './utils/is-client-request.js';
import isUnixSocketURL, {getUnixSocketPath} from './utils/is-unix-socket-url.js';
import {
	RequestError,
	ReadError,
	MaxRedirectsError,
	HTTPError,
	TimeoutError,
	UploadError,
	CacheError,
	AbortError,
} from './errors.js';
import {
	type RequestId,
	generateRequestId,
	publishRequestCreate,
	publishRequestStart,
	publishResponseStart,
	publishResponseEnd,
	publishRetry,
	publishError,
	publishRedirect,
} from './diagnostics-channel.js';

type Error = NodeJS.ErrnoException;

export type Progress = {
	percent: number;
	transferred: number;
	total?: number;
};

const supportsBrotli = is.string(process.versions.brotli);
const supportsZstd = is.string(process.versions.zstd);

const methodsWithoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);
// Methods that should auto-end streams when no body is provided
const methodsWithoutBodyStream: ReadonlySet<string> = new Set(['OPTIONS', 'DELETE', 'PATCH']);

export type GotEventFunction<T> =
	/**
	`request` event to get the request object of the request.

	 __Tip__: You can use `request` event to abort requests.

	@example
	```
	import got from 'got';

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

	```
	{
		percent: 0.1,
		transferred: 1024,
		total: 10240
	}
	```

	If the `content-length` header is missing, `total` will be `undefined`.

	@example
	```
	import got from 'got';

	const response = await got('https://sindresorhus.com')
		.on('downloadProgress', progress => {
			// Report download progress
		})
		.on('uploadProgress', progress => {
			// Report upload progress
		});

	console.log(response);
	```
	*/
	& ((name: 'uploadProgress' | 'downloadProgress', listener: (progress: Progress) => void) => T)
	/**
	To enable retrying on a Got stream, it is required to have a `retry` handler attached.

	When this event is emitted, you should reset the stream you were writing to and prepare the body again.

	See `got.options.retry` for more information.
	*/
	& ((name: 'retry', listener: (retryCount: number, error: RequestError, createRetryStream: (options?: OptionsInit) => Request) => void) => T);

export type RequestEvents<T> = {
	on: GotEventFunction<T>;
	once: GotEventFunction<T>;
	off: GotEventFunction<T>;
};

type StorageAdapter = KeyvStoreAdapter | KeyvType | Map<any, any>;

const cacheableStore = new WeakableMap<string | StorageAdapter, CacheableRequestFunction>();

const redirectCodes: ReadonlySet<number> = new Set([300, 301, 302, 303, 304, 307, 308]);

// Track errors that have been processed by beforeError hooks to preserve custom error types
const errorsProcessedByHooks = new WeakSet<Error>();

const proxiedRequestEvents = [
	'socket',
	'connect',
	'continue',
	'information',
	'upgrade',
] as const;

const noop = (): void => {};

type UrlType = ConstructorParameters<typeof Options>[0];
type OptionsType = ConstructorParameters<typeof Options>[1];
type DefaultsType = ConstructorParameters<typeof Options>[2];

/**
Stream transform that counts bytes passing through.
Used to track compressed bytes before decompression for content-length validation.
*/
class ByteCounter extends Transform {
	count = 0;

	override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		this.count += chunk.length;
		callback(null, chunk);
	}
}

export default class Request extends Duplex implements RequestEvents<Request> {
	// @ts-expect-error - Ignoring for now.
	override ['constructor']: typeof Request;

	_noPipe?: boolean;

	// @ts-expect-error https://github.com/microsoft/TypeScript/issues/9568
	options: Options;
	response?: PlainResponse;
	requestUrl?: URL;
	redirectUrls: URL[];
	retryCount: number;
	_stopReading: boolean;

	declare private _requestOptions: NativeRequestOptions;

	private _stopRetry: () => void;
	private _downloadedSize: number;
	private _uploadedSize: number;
	private readonly _pipedServerResponses: Set<ServerResponse>;
	private _request?: ClientRequest;
	private _responseSize?: number;
	private _bodySize?: number;
	private _unproxyEvents: () => void;
	private _isFromCache?: boolean;
	private _triggerRead: boolean;
	declare private readonly _jobs: Array<() => void>;
	private _cancelTimeouts: () => void;
	private readonly _removeListeners: () => void;
	private _nativeResponse?: IncomingMessageWithTimings;
	private _flushed: boolean;
	private _aborted: boolean;
	private _expectedContentLength?: number;
	private _byteCounter?: ByteCounter;
	private readonly _requestId: RequestId;

	// We need this because `this._request` if `undefined` when using cache
	private _requestInitialized: boolean;

	constructor(url: UrlType, options?: OptionsType, defaults?: DefaultsType) {
		super({
			// Don't destroy immediately, as the error may be emitted on unsuccessful retry
			autoDestroy: false,
			// It needs to be zero because we're just proxying the data to another stream
			highWaterMark: 0,
		});

		this._downloadedSize = 0;
		this._uploadedSize = 0;
		this._stopReading = false;
		this._pipedServerResponses = new Set<ServerResponse>();
		this._unproxyEvents = noop;
		this._triggerRead = false;
		this._cancelTimeouts = noop;
		this._removeListeners = noop;
		this._jobs = [];
		this._flushed = false;
		this._requestInitialized = false;
		this._aborted = false;

		this.redirectUrls = [];
		this.retryCount = 0;

		this._stopRetry = noop;
		this._requestId = generateRequestId();

		this.on('pipe', (source: NodeJS.ReadableStream & {headers?: Record<string, string | string[] | undefined>}) => {
			if (this.options.copyPipedHeaders && source?.headers) {
				Object.assign(this.options.headers, source.headers);
			}
		});

		this.on('newListener', event => {
			if (event === 'retry' && this.listenerCount('retry') > 0) {
				throw new Error('A retry listener has been attached already.');
			}
		});

		try {
			this.options = new Options(url, options, defaults);

			if (!this.options.url) {
				if (this.options.prefixUrl === '') {
					throw new TypeError('Missing `url` property');
				}

				this.options.url = '';
			}

			this.requestUrl = this.options.url as URL;

			// Publish request creation event
			publishRequestCreate({
				requestId: this._requestId,
				url: this.options.url?.toString() ?? '',
				method: this.options.method,
			});
		} catch (error: any) {
			const {options} = error as OptionsError;
			if (options) {
				this.options = options;
			}

			this.flush = async () => {
				this.flush = async () => {};

				// Defer error emission to next tick to allow user to attach error handlers
				process.nextTick(() => {
					// _beforeError requires options to access retry logic and hooks
					if (this.options) {
						this._beforeError(error);
					} else {
						// Options is undefined, skip _beforeError and destroy directly
						const requestError = error instanceof RequestError ? error : new RequestError(error.message, error, this);
						this.destroy(requestError);
					}
				});
			};

			return;
		}

		// Important! If you replace `body` in a handler with another stream, make sure it's readable first.
		// The below is run only once.
		const {body} = this.options;
		if (is.nodeStream(body)) {
			body.once('error', error => {
				if (this._flushed) {
					this._beforeError(new UploadError(error, this));
				} else {
					this.flush = async () => {
						this.flush = async () => {};

						this._beforeError(new UploadError(error, this));
					};
				}
			});
		}

		if (this.options.signal) {
			const abort = () => {
				// See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static#return_value
				if (this.options.signal?.reason?.name === 'TimeoutError') {
					this.destroy(new TimeoutError(this.options.signal.reason, this.timings!, this));
				} else {
					this.destroy(new AbortError(this));
				}
			};

			if (this.options.signal.aborted) {
				abort();
			} else {
				this.options.signal.addEventListener('abort', abort);

				this._removeListeners = () => {
					this.options.signal?.removeEventListener('abort', abort);
				};
			}
		}
	}

	async flush() {
		if (this._flushed) {
			return;
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

			this._requestInitialized = true;
		} catch (error: any) {
			this._beforeError(error);
		}
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
			// Node.js parser is really weird.
			// It emits post-request Parse Errors on the same instance as previous request. WTF.
			// Therefore, we need to check if it has been destroyed as well.
			//
			// Furthermore, Node.js 16 `response.destroy()` doesn't immediately destroy the socket,
			// but makes the response unreadable. So we additionally need to check `response.readable`.
			if (response?.readable && !response.rawBody && !this._request?.socket?.destroyed) {
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

					const computedValue = calculateRetryDelay({
						attemptCount,
						retryOptions,
						error: typedError,
						retryAfter,
						computedValue: retryOptions.maxRetryAfter ?? options.timeout.request ?? Number.POSITIVE_INFINITY,
					});

					// When enforceRetryRules is true, respect the retry rules (limit, methods, statusCodes, errorCodes)
					// before calling the user's calculateDelay function. If computedValue is 0 (meaning retry is not allowed
					// based on these rules), skip calling calculateDelay entirely.
					// When false (default), always call calculateDelay, allowing it to override retry decisions.
					if (retryOptions.enforceRetryRules && computedValue === 0) {
						backoff = 0;
					} else {
						backoff = await retryOptions.calculateDelay({
							attemptCount,
							retryOptions,
							error: typedError,
							retryAfter,
							computedValue,
						});
					}
				} catch (error_: any) {
					void this._error(new RequestError(error_.message, error_, this));
					return;
				}

				if (backoff) {
					await new Promise<void>(resolve => {
						const timeout = setTimeout(resolve, backoff);
						this._stopRetry = () => {
							clearTimeout(timeout);
							resolve();
						};
					});

					// Something forced us to abort the retry
					if (this.destroyed) {
						return;
					}

					// Capture body BEFORE hooks run to detect reassignment
					const bodyBeforeHooks = this.options.body;

					try {
						for (const hook of this.options.hooks.beforeRetry) {
							// eslint-disable-next-line no-await-in-loop
							await hook(typedError, this.retryCount + 1);
						}
					} catch (error_: any) {
						void this._error(new RequestError(error_.message, error_, this));
						return;
					}

					// Something forced us to abort the retry
					if (this.destroyed) {
						return;
					}

					// Preserve stream body reassigned in beforeRetry hooks.
					const bodyAfterHooks = this.options.body;
					const bodyWasReassigned = bodyBeforeHooks !== bodyAfterHooks;

					// Resource cleanup and preservation logic for retry with body reassignment.
					// The Promise wrapper (as-promise/index.ts) compares body identity to detect consumed streams,
					// so we must preserve the body reference across destroy(). However, destroy() calls _destroy()
					// which destroys this.options.body, creating a complex dance of clear/restore operations.
					//
					// Key constraints:
					// 1. If body was reassigned, we must NOT destroy the NEW stream (it will be used for retry)
					// 2. If body was reassigned, we MUST destroy the OLD stream to prevent memory leaks
					// 3. We must restore the body reference after destroy() for identity checks in promise wrapper
					// 4. We cannot use the normal setter after destroy() because it validates stream readability
					if (bodyWasReassigned) {
						const oldBody = bodyBeforeHooks;
						// Temporarily clear body to prevent destroy() from destroying the new stream
						this.options.body = undefined;
						this.destroy();

						// Clean up the old stream resource if it's a stream and different from new body
						// (edge case: if old and new are same stream object, don't destroy it)
						if (is.nodeStream(oldBody) && oldBody !== bodyAfterHooks) {
							oldBody.destroy();
						}

						// Restore new body for promise wrapper's identity check
						// We bypass the setter because it validates stream.readable (which fails for destroyed request)
						// Type assertion is necessary here to access private _internals without exposing internal API
						if (is.nodeStream(bodyAfterHooks) && (bodyAfterHooks.readableEnded || bodyAfterHooks.destroyed)) {
							throw new TypeError('The reassigned stream body must be readable. Ensure you provide a fresh, readable stream in the beforeRetry hook.');
						}

						(this.options as any)._internals.body = bodyAfterHooks;
					} else {
						// Body wasn't reassigned - use normal destroy flow which handles body cleanup
						this.destroy();
						// Note: We do NOT restore the body reference here. The stream was destroyed by _destroy()
						// and should not be accessed. The promise wrapper will see that body identity hasn't changed
						// and will detect it's a consumed stream, which is the correct behavior.
					}

					// Publish retry event
					publishRetry({
						requestId: this._requestId,
						retryCount: this.retryCount + 1,
						error: typedError,
						delay: backoff,
					});

					this.emit('retry', this.retryCount + 1, error, (updatedOptions?: OptionsInit) => {
						const request = new Request(options.url, updatedOptions, options);
						request.retryCount = this.retryCount + 1;

						process.nextTick(() => {
							void request.flush();
						});

						return request;
					});
					return;
				}
			}

			void this._error(typedError);
		})();
	}

	override _read(): void {
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
				this._downloadedSize += data.length; // eslint-disable-line @typescript-eslint/restrict-plus-operands

				const progress = this.downloadProgress;

				if (progress.percent < 1) {
					this.emit('downloadProgress', progress);
				}

				this.push(data);
			}
		}
	}

	override _write(chunk: unknown, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void { // eslint-disable-line @typescript-eslint/ban-types
		const write = (): void => {
			this._writeRequest(chunk, encoding, callback);
		};

		if (this._requestInitialized) {
			write();
		} else {
			this._jobs.push(write);
		}
	}

	override _final(callback: (error?: Error | null) => void): void { // eslint-disable-line @typescript-eslint/ban-types
		const endRequest = (): void => {
			// We need to check if `this._request` is present,
			// because it isn't when we use cache.
			if (!this._request || this._request.destroyed) {
				callback();
				return;
			}

			this._request.end((error?: Error | null) => { // eslint-disable-line @typescript-eslint/ban-types
				// The request has been destroyed before `_final` finished.
				// See https://github.com/nodejs/node/issues/39356
				if ((this._request as any)?._writableState?.errored) {
					return;
				}

				if (!error) {
					this._bodySize = this._uploadedSize;

					this.emit('uploadProgress', this.uploadProgress);
					this._request?.emit('upload-complete');
				}

				callback(error);
			});
		};

		if (this._requestInitialized) {
			endRequest();
		} else {
			this._jobs.push(endRequest);
		}
	}

	override _destroy(error: Error | null, callback: (error: Error | null) => void): void { // eslint-disable-line @typescript-eslint/ban-types
		this._stopReading = true;
		this.flush = async () => {};

		// Prevent further retries
		this._stopRetry();
		this._cancelTimeouts();
		this._removeListeners();

		if (this.options) {
			const {body} = this.options;
			if (is.nodeStream(body)) {
				body.destroy();
			}
		}

		if (this._request) {
			this._request.destroy();
		}

		// Workaround: http-timer only sets timings.end when the response emits 'end'.
		// When a stream is destroyed before completion, the 'end' event may not fire,
		// leaving timings.end undefined. This should ideally be fixed in http-timer
		// by listening to the 'close' event, but we handle it here for now.
		// Only set timings.end if there was no error or abort (to maintain semantic correctness).
		const timings = (this._request as ClientRequestWithTimings)?.timings;
		if (timings && is.undefined(timings.end) && !is.undefined(timings.response) && is.undefined(timings.error) && is.undefined(timings.abort)) {
			timings.end = Date.now();
			if (is.undefined(timings.phases.total)) {
				timings.phases.download = timings.end - timings.response;
				timings.phases.total = timings.end - timings.start;
			}
		}

		// Preserve custom errors returned by beforeError hooks.
		// For other errors, wrap non-RequestError instances for consistency.
		if (error !== null && !is.undefined(error)) {
			const processedByHooks = error instanceof Error && errorsProcessedByHooks.has(error);

			if (!processedByHooks && !(error instanceof RequestError)) {
				error = error instanceof Error
					? new RequestError(error.message, error, this)
					: new RequestError(String(error), {}, this);
			}
		}

		callback(error);
	}

	override pipe<T extends NodeJS.WritableStream>(destination: T, options?: {end?: boolean}): T {
		if (destination instanceof ServerResponse) {
			this._pipedServerResponses.add(destination);
		}

		return super.pipe(destination, options);
	}

	override unpipe<T extends NodeJS.WritableStream>(destination: T): this {
		if (destination instanceof ServerResponse) {
			this._pipedServerResponses.delete(destination);
		}

		super.unpipe(destination);

		return this;
	}

	private _checkContentLengthMismatch(): boolean {
		if (this.options.strictContentLength && this._expectedContentLength !== undefined) {
			// Use ByteCounter's count when available (for compressed responses),
			// otherwise use _downloadedSize (for uncompressed responses)
			const actualSize = this._byteCounter?.count ?? this._downloadedSize;
			if (actualSize !== this._expectedContentLength) {
				this._beforeError(new ReadError({
					message: `Content-Length mismatch: expected ${this._expectedContentLength} bytes, received ${actualSize} bytes`,
					name: 'Error',
					code: 'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
				}, this));
				return true;
			}
		}

		return false;
	}

	private async _finalizeBody(): Promise<void> {
		const {options} = this;
		const {headers} = options;

		const isForm = !is.undefined(options.form);
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const isJSON = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		const cannotHaveBody = methodsWithoutBody.has(options.method) && !(options.method === 'GET' && options.allowGetBody);

		if (isForm || isJSON || isBody) {
			if (cannotHaveBody) {
				throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
			}

			// Serialize body
			const noContentType = !is.string(headers['content-type']);

			if (isBody) {
				// Body is spec-compliant FormData
				if (isFormDataLike(options.body)) {
					const encoder = new FormDataEncoder(options.body);

					if (noContentType) {
						headers['content-type'] = encoder.headers['Content-Type'];
					}

					if ('Content-Length' in encoder.headers) {
						headers['content-length'] = encoder.headers['Content-Length'];
					}

					options.body = encoder.encode();
				}

				// Special case for https://github.com/form-data/form-data
				if (isFormData(options.body) && noContentType) {
					headers['content-type'] = `multipart/form-data; boundary=${options.body.getBoundary()}`;
				}
			} else if (isForm) {
				if (noContentType) {
					headers['content-type'] = 'application/x-www-form-urlencoded';
				}

				const {form} = options;
				options.form = undefined;

				options.body = (new URLSearchParams(form as Record<string, string>)).toString();
			} else {
				if (noContentType) {
					headers['content-type'] = 'application/json';
				}

				const {json} = options;
				options.json = undefined;

				options.body = options.stringifyJson(json);
			}

			const uploadBodySize = await getBodySize(options.body, options.headers);

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

		if (options.responseType === 'json' && !('accept' in options.headers)) {
			options.headers.accept = 'application/json';
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

		const statusCode = response.statusCode!;
		const {method} = options;

		// Skip decompression for responses that must not have bodies per RFC 9110:
		// - HEAD responses (any status code)
		// - 1xx (Informational): 100, 101, 102, 103, etc.
		// - 204 (No Content)
		// - 205 (Reset Content)
		// - 304 (Not Modified)
		const hasNoBody = method === 'HEAD'
			|| (statusCode >= 100 && statusCode < 200)
			|| statusCode === 204
			|| statusCode === 205
			|| statusCode === 304;

		if (options.decompress && !hasNoBody) {
			// When strictContentLength is enabled, track compressed bytes by listening to
			// the native response's data events before decompression
			if (options.strictContentLength) {
				this._byteCounter = new ByteCounter();
				this._nativeResponse.on('data', (chunk: Buffer) => {
					this._byteCounter!.count += chunk.length;
				});
			}

			response = decompressResponse(response);
		}

		const typedResponse = response as PlainResponse;

		typedResponse.statusMessage = typedResponse.statusMessage || http.STATUS_CODES[statusCode]; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- The status message can be empty.
		typedResponse.url = options.url!.toString();
		typedResponse.requestUrl = this.requestUrl!;
		typedResponse.redirectUrls = this.redirectUrls;
		typedResponse.request = this;
		typedResponse.isFromCache = (this._nativeResponse as any).fromCache ?? false;
		typedResponse.ip = this.ip;
		typedResponse.retryCount = this.retryCount;
		typedResponse.ok = isResponseOk(typedResponse);

		this._isFromCache = typedResponse.isFromCache;

		this._responseSize = Number(response.headers['content-length']) || undefined;

		this.response = typedResponse;

		// Publish response start event
		publishResponseStart({
			requestId: this._requestId,
			url: typedResponse.url,
			statusCode,
			headers: response.headers,
			isFromCache: typedResponse.isFromCache,
		});

		// Workaround for http-timer bug: when connecting to an IP address (no DNS lookup),
		// http-timer sets lookup = connect instead of lookup = socket, resulting in
		// dns = lookup - socket being a small positive number instead of 0.
		// See https://github.com/sindresorhus/got/issues/2279
		const {timings} = response;
		if (timings?.lookup !== undefined && timings.socket !== undefined && timings.connect !== undefined && timings.lookup === timings.connect && timings.phases.dns !== 0) {
			// Fix the DNS phase to be 0 and set lookup to socket time
			timings.phases.dns = 0;
			timings.lookup = timings.socket;
			// Recalculate TCP time to be the full time from socket to connect
			timings.phases.tcp = timings.connect - timings.socket;
		}

		// Workaround for http-timer limitation with HTTP/2:
		// When using HTTP/2, the socket is a proxy that http-timer discards,
		// so lookup, connect, and secureConnect events are never captured.
		// This results in phases.request being NaN (undefined - undefined).
		// Set it to undefined to be consistent with other unavailable timings.
		// See https://github.com/sindresorhus/got/issues/1958
		if (timings && Number.isNaN(timings.phases.request)) {
			timings.phases.request = undefined;
		}

		response.once('error', (error: Error) => {
			this._aborted = true;

			// Force clean-up, because some packages don't do this.
			// TODO: Fix decompress-response
			response.destroy();

			this._beforeError(new ReadError(error, this));
		});

		response.once('aborted', () => {
			this._aborted = true;

			// Check if there's a content-length mismatch to provide a more specific error
			if (!this._checkContentLengthMismatch()) {
				this._beforeError(new ReadError({
					name: 'Error',
					message: 'The server aborted pending request',
					code: 'ECONNRESET',
				}, this));
			}
		});

		const rawCookies = response.headers['set-cookie'];
		if (is.object(options.cookieJar) && rawCookies) {
			let promises: Array<Promise<unknown>> = rawCookies.map(async (rawCookie: string) => (options.cookieJar as PromiseCookieJar).setCookie(rawCookie, url!.toString()));

			if (options.ignoreInvalidCookies) {
				// eslint-disable-next-line @typescript-eslint/no-floating-promises
				promises = promises.map(async promise => {
					try {
						await promise;
					} catch {}
				});
			}

			try {
				await Promise.all(promises);
			} catch (error: any) {
				this._beforeError(error);
				return;
			}
		}

		// The above is running a promise, therefore we need to check if this request has been aborted yet again.
		if (this.isAborted) {
			return;
		}

		if (response.headers.location && redirectCodes.has(statusCode)) {
			// We're being redirected, we don't care about the response.
			// It'd be best to abort the request, but we can't because
			// we would have to sacrifice the TCP connection. We don't want that.
			const shouldFollow = typeof options.followRedirect === 'function' ? options.followRedirect(typedResponse) : options.followRedirect;
			if (shouldFollow) {
				response.resume();

				this._cancelTimeouts();
				this._unproxyEvents();

				if (this.redirectUrls.length >= options.maxRedirects) {
					this._beforeError(new MaxRedirectsError(this));
					return;
				}

				this._request = undefined;

				// Reset download progress for the new request
				this._downloadedSize = 0;

				const updatedOptions = new Options(undefined, undefined, this.options);

				const serverRequestedGet = statusCode === 303 && updatedOptions.method !== 'GET' && updatedOptions.method !== 'HEAD';
				const canRewrite = statusCode !== 307 && statusCode !== 308;
				const userRequestedGet = updatedOptions.methodRewriting && canRewrite;

				if (serverRequestedGet || userRequestedGet) {
					updatedOptions.method = 'GET';

					updatedOptions.body = undefined;
					updatedOptions.json = undefined;
					updatedOptions.form = undefined;

					delete updatedOptions.headers['content-length'];
				}

				try {
					// We need this in order to support UTF-8
					const redirectBuffer = Buffer.from(response.headers.location, 'binary').toString();
					const redirectUrl = new URL(redirectBuffer, url);

					if (!isUnixSocketURL(url as URL) && isUnixSocketURL(redirectUrl)) {
						this._beforeError(new RequestError('Cannot redirect to UNIX socket', {}, this));
						return;
					}

					// Redirecting to a different site, clear sensitive data.
					// For UNIX sockets, different socket paths are also different origins.
					const isDifferentOrigin = redirectUrl.hostname !== (url as URL).hostname
						|| redirectUrl.port !== (url as URL).port
						|| getUnixSocketPath(url as URL) !== getUnixSocketPath(redirectUrl);

					if (isDifferentOrigin) {
						if ('host' in updatedOptions.headers) {
							delete updatedOptions.headers.host;
						}

						if ('cookie' in updatedOptions.headers) {
							delete updatedOptions.headers.cookie;
						}

						if ('authorization' in updatedOptions.headers) {
							delete updatedOptions.headers.authorization;
						}

						if (updatedOptions.username || updatedOptions.password) {
							updatedOptions.username = '';
							updatedOptions.password = '';
						}
					} else {
						redirectUrl.username = updatedOptions.username;
						redirectUrl.password = updatedOptions.password;
					}

					this.redirectUrls.push(redirectUrl);
					updatedOptions.url = redirectUrl;

					for (const hook of updatedOptions.hooks.beforeRedirect) {
						// eslint-disable-next-line no-await-in-loop
						await hook(updatedOptions as NormalizedOptions, typedResponse);
					}

					// Publish redirect event
					publishRedirect({
						requestId: this._requestId,
						fromUrl: url!.toString(),
						toUrl: redirectUrl.toString(),
						statusCode,
					});

					this.emit('redirect', updatedOptions, typedResponse);

					this.options = updatedOptions;

					await this._makeRequest();
				} catch (error: any) {
					this._beforeError(error);
					return;
				}

				return;
			}
		}

		// `HTTPError`s always have `error.response.body` defined.
		// Therefore, we cannot retry if `options.throwHttpErrors` is false.
		// On the last retry, if `options.throwHttpErrors` is false, we would need to return the body,
		// but that wouldn't be possible since the body would be already read in `error.response.body`.
		if (options.isStream && options.throwHttpErrors && !isResponseOk(typedResponse)) {
			this._beforeError(new HTTPError(typedResponse));
			return;
		}

		// Store the expected content-length from the native response for validation.
		// This is the content-length before decompression, which is what actually gets transferred.
		// Skip storing for responses that shouldn't have bodies per RFC 9110.
		// When decompression occurs, only store if strictContentLength is enabled.
		const wasDecompressed = response !== this._nativeResponse;
		if (!hasNoBody && (!wasDecompressed || options.strictContentLength)) {
			const contentLengthHeader = this._nativeResponse.headers['content-length'];
			if (contentLengthHeader !== undefined) {
				const expectedLength = Number(contentLengthHeader);
				if (!Number.isNaN(expectedLength) && expectedLength >= 0) {
					this._expectedContentLength = expectedLength;
				}
			}
		}

		// Set up end listener AFTER redirect check to avoid emitting progress for redirect responses
		response.once('end', () => {
			// Validate content-length if it was provided
			// Per RFC 9112: "If the sender closes the connection before the indicated number
			// of octets are received, the recipient MUST consider the message to be incomplete"
			if (this._checkContentLengthMismatch()) {
				return;
			}

			this._responseSize = this._downloadedSize;
			this.emit('downloadProgress', this.downloadProgress);

			// Publish response end event
			publishResponseEnd({
				requestId: this._requestId,
				url: typedResponse.url,
				statusCode,
				bodySize: this._downloadedSize,
				timings: this.timings,
			});

			this.push(null);
		});

		this.emit('downloadProgress', this.downloadProgress);

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

			// Check if decompression actually occurred by comparing stream objects.
			// decompressResponse wraps the response stream when it decompresses,
			// so response !== this._nativeResponse indicates decompression happened.
			const wasDecompressed = response !== this._nativeResponse;

			for (const key in response.headers) {
				if (Object.hasOwn(response.headers, key)) {
					const value = response.headers[key];

					// When decompression occurred, skip content-encoding and content-length
					// as they refer to the compressed data, not the decompressed stream.
					if (wasDecompressed && (key === 'content-encoding' || key === 'content-length')) {
						continue;
					}

					// Skip if value is undefined
					if (value !== undefined) {
						destination.setHeader(key, value);
					}
				}
			}

			destination.statusCode = statusCode;
		}
	}

	private async _setRawBody(from: Readable = this): Promise<boolean> {
		if (from.readableEnded) {
			return false;
		}

		try {
			// Errors are emitted via the `error` event
			const fromArray = await from.toArray();
			const rawBody = isBuffer(fromArray.at(0)) ? Buffer.concat(fromArray) : Buffer.from(fromArray.join(''));

			// On retry Request is destroyed with no error, therefore the above will successfully resolve.
			// So in order to check if this was really successfull, we need to check if it has been properly ended.
			if (!this.isAborted) {
				this.response!.rawBody = rawBody;

				return true;
			}
		} catch {}

		return false;
	}

	private async _onResponse(response: IncomingMessageWithTimings): Promise<void> {
		try {
			await this._onResponseBase(response);
		} catch (error: any) {
			/* istanbul ignore next: better safe than sorry */
			this._beforeError(error);
		}
	}

	private _onRequest(request: ClientRequest): void {
		const {options} = this;
		const {timeout, url} = options;

		// Publish request start event
		publishRequestStart({
			requestId: this._requestId,
			url: url?.toString() ?? '',
			method: options.method,
			headers: options.headers,
		});

		timer(request);

		this._cancelTimeouts = timedOut(request, timeout, url as URL);

		if (this.options.http2) {
			// Unset stream timeout, as the `timeout` option was used only for connection timeout.
			// We remove all 'timeout' listeners instead of calling setTimeout(0) because:
			// 1. setTimeout(0) causes a memory leak (see https://github.com/sindresorhus/got/issues/690)
			// 2. With HTTP/2 connection reuse, setTimeout(0) accumulates listeners on the socket
			// 3. removeAllListeners('timeout') properly cleans up without the memory leak
			request.removeAllListeners('timeout');

			// For HTTP/2, wait for socket and remove timeout listeners from it
			request.once('socket', (socket: Socket) => {
				socket.removeAllListeners('timeout');
			});
		}

		const responseEventName = options.cache ? 'cacheableResponse' : 'response';

		request.once(responseEventName, (response: IncomingMessageWithTimings) => {
			void this._onResponse(response);
		});

		request.once('error', (error: Error) => {
			this._aborted = true;

			// Force clean-up, because some packages (e.g. nock) don't do this.
			request.destroy();

			error = error instanceof TimedOutTimeoutError ? new TimeoutError(error, this.timings!, this) : new RequestError(error.message, error, this);

			this._beforeError(error);
		});

		this._unproxyEvents = proxyEvents(request, this, proxiedRequestEvents);

		this._request = request;

		this.emit('uploadProgress', this.uploadProgress);

		this._sendBody();

		this.emit('request', request);
	}

	private async _asyncWrite(chunk: any): Promise<void> {
		return new Promise((resolve, reject) => {
			super.write(chunk, error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	private _sendBody() {
		// Send body
		const {body} = this.options;
		const currentRequest = this.redirectUrls.length === 0 ? this : this._request ?? this;

		if (is.nodeStream(body)) {
			body.pipe(currentRequest);
		} else if (is.buffer(body)) {
			// Buffer should be sent directly without conversion
			this._writeRequest(body, undefined, () => {});
			currentRequest.end();
		} else if (is.typedArray(body)) {
			// Typed arrays should be treated like buffers, not iterated over
			// Create a Uint8Array view over the data (Node.js streams accept Uint8Array)
			const typedArray = body as ArrayBufferView;
			const uint8View = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
			this._writeRequest(uint8View, undefined, () => {});
			currentRequest.end();
		} else if (is.asyncIterable(body) || (is.iterable(body) && !is.string(body) && !isBuffer(body))) {
			(async () => {
				try {
					for await (const chunk of body) {
						await this._asyncWrite(chunk);
					}

					super.end();
				} catch (error: any) {
					this._beforeError(error);
				}
			})();
		} else if (is.undefined(body)) {
			// No body to send, end the request
			const cannotHaveBody = methodsWithoutBody.has(this.options.method) && !(this.options.method === 'GET' && this.options.allowGetBody);
			const shouldAutoEndStream = methodsWithoutBodyStream.has(this.options.method);

			if ((this._noPipe ?? false) || cannotHaveBody || currentRequest !== this || shouldAutoEndStream) {
				currentRequest.end();
			}
		} else {
			this._writeRequest(body, undefined, () => {});
			currentRequest.end();
		}
	}

	private _prepareCache(cache: string | StorageAdapter) {
		if (cacheableStore.has(cache)) {
			return;
		}

		const cacheableRequest = new CacheableRequest(
			((requestOptions: RequestOptions, handler?: (response: IncomingMessageWithTimings) => void): ClientRequest => {
				/**
				Wraps the cacheable-request handler to run beforeCache hooks.
				These hooks control caching behavior by:
				- Directly mutating the response object (changes apply to what gets cached)
				- Returning `false` to prevent caching
				- Returning `void`/`undefined` to use default caching behavior

				Hooks use direct mutation - they can modify response.headers, response.statusCode, etc.
				Mutations take effect immediately and determine what gets cached.
				*/
				const wrappedHandler = handler ? (response: IncomingMessageWithTimings) => {
					const {beforeCacheHooks, gotRequest} = requestOptions as any;

					// Early return if no hooks - cache the original response
					if (!beforeCacheHooks || beforeCacheHooks.length === 0) {
						handler(response);
						return;
					}

					try {
						// Call each beforeCache hook with the response
						// Hooks can directly mutate the response - mutations take effect immediately
						for (const hook of beforeCacheHooks) {
							const result = hook(response);

							if (result === false) {
								// Prevent caching by adding no-cache headers
								// Mutate the response directly to add headers
								response.headers['cache-control'] = 'no-cache, no-store, must-revalidate';
								response.headers.pragma = 'no-cache';
								response.headers.expires = '0';
								handler(response);
								// Don't call remaining hooks - we've decided not to cache
								return;
							}

							if (is.promise(result)) {
								// BeforeCache hooks must be synchronous because cacheable-request's handler is synchronous
								throw new TypeError('beforeCache hooks must be synchronous. The hook returned a Promise, but this hook must return synchronously. If you need async logic, use beforeRequest hook instead.');
							}

							if (result !== undefined) {
								// Hooks should return false or undefined only
								// Mutations work directly - no need to return the response
								throw new TypeError('beforeCache hook must return false or undefined. To modify the response, mutate it directly.');
							}
							// Else: void/undefined = continue
						}
					} catch (error: any) {
						// Convert hook errors to RequestError and propagate
						// This is consistent with how other hooks handle errors
						if (gotRequest) {
							gotRequest._beforeError(error instanceof RequestError ? error : new RequestError(error.message, error, gotRequest));
							// Don't call handler when error was propagated successfully
							return;
						}

						// If gotRequest is missing, log the error to aid debugging
						// We still call the handler to prevent the request from hanging
						console.error('Got: beforeCache hook error (request context unavailable):', error);
						// Call handler with response (potentially partially modified)
						handler(response);
						return;
					}

					// All hooks ran successfully
					// Cache the response with any mutations applied
					handler(response);
				} : handler;

				const result = (requestOptions as any)._request(requestOptions, wrappedHandler);

				// TODO: remove this when `cacheable-request` supports async request functions.
				if (is.promise(result)) {
					// We only need to implement the error handler in order to support HTTP2 caching.
					// The result will be a promise anyway.
					// @ts-expect-error ignore
					result.once = (event: string, handler: (reason: unknown) => void) => {
						if (event === 'error') {
							(async () => {
								try {
									await result;
								} catch (error) {
									handler(error);
								}
							})();
						} else if (event === 'abort' || event === 'destroy') {
							// The empty catch is needed here in case when
							// it rejects before it's `await`ed in `_makeRequest`.
							(async () => {
								try {
									const request = (await result) as ClientRequest;
									request.once(event, handler);
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
			cache as StorageAdapter,
		);
		cacheableStore.set(cache, cacheableRequest.request());
	}

	private async _createCacheableRequest(url: URL, options: RequestOptions): Promise<ClientRequest | ResponseLike> {
		return new Promise<ClientRequest | ResponseLike>((resolve, reject) => {
			// TODO: Remove `utils/url-to-options.ts` when `cacheable-request` is fixed
			Object.assign(options, urlToOptions(url));

			let request: ClientRequest | Promise<ClientRequest>;

			// TODO: Fix `cacheable-response`. This is ugly.
			const cacheRequest = cacheableStore.get((options as any).cache)!(options as CacheableOptions, async (response: any) => {
				response._readableState.autoDestroy = false;

				if (request) {
					const fix = () => {
						// For ResponseLike objects from cache, set complete to true if not already set.
						// For real HTTP responses, copy from the underlying response.
						if (response.req) {
							response.complete = response.req.res.complete;
						} else if (response.complete === undefined) {
							// ResponseLike from cache should have complete = true
							response.complete = true;
						}
					};

					response.prependOnceListener('end', fix);
					fix();

					(await request).emit('cacheableResponse', response);
				}

				resolve(response);
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
		const {headers, username, password} = options;
		const cookieJar = options.cookieJar as PromiseCookieJar | undefined;

		for (const key in headers) {
			if (is.undefined(headers[key])) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete headers[key];
			} else if (is.null(headers[key])) {
				throw new TypeError(`Use \`undefined\` instead of \`null\` to delete the \`${key}\` header`);
			}
		}

		if (options.decompress && is.undefined(headers['accept-encoding'])) {
			const encodings = ['gzip', 'deflate'];
			if (supportsBrotli) {
				encodings.push('br');
			}

			if (supportsZstd) {
				encodings.push('zstd');
			}

			headers['accept-encoding'] = encodings.join(', ');
		}

		if (username || password) {
			const credentials = Buffer.from(`${username}:${password}`).toString('base64');
			headers.authorization = `Basic ${credentials}`;
		}

		// Set cookies
		if (cookieJar) {
			const cookieString: string = await cookieJar.getCookieString(options.url!.toString());

			if (is.nonEmptyString(cookieString)) {
				headers.cookie = cookieString;
			}
		}

		let request: ReturnType<Options['getRequestFunction']> | undefined;

		for (const hook of options.hooks.beforeRequest) {
			// eslint-disable-next-line no-await-in-loop
			const result = await hook(options as NormalizedOptions, {retryCount: this.retryCount});

			if (!is.undefined(result)) {
				// @ts-expect-error Skip the type mismatch to support abstract responses
				request = () => result;
				break;
			}
		}

		request ||= options.getRequestFunction();

		const url = options.url as URL;

		this._requestOptions = options.createNativeRequestOptions() as NativeRequestOptions;

		if (options.cache) {
			(this._requestOptions as any)._request = request;
			(this._requestOptions as any).cache = options.cache;
			(this._requestOptions as any).body = options.body;
			(this._requestOptions as any).beforeCacheHooks = options.hooks.beforeCache;
			(this._requestOptions as any).gotRequest = this;

			try {
				this._prepareCache(options.cache as StorageAdapter);
			} catch (error: any) {
				throw new CacheError(error, this);
			}
		}

		// Cache support
		const function_ = options.cache ? this._createCacheableRequest : request;

		try {
			// We can't do `await fn(...)`,
			// because stream `error` event can be emitted before `Promise.resolve()`.
			let requestOrResponse = function_!(url, this._requestOptions);

			if (is.promise(requestOrResponse)) {
				requestOrResponse = await requestOrResponse;
			}

			// Fallback
			if (is.undefined(requestOrResponse)) {
				requestOrResponse = options.getFallbackRequestFunction()!(url, this._requestOptions);

				if (is.promise(requestOrResponse)) {
					requestOrResponse = await requestOrResponse;
				}
			}

			if (isClientRequest(requestOrResponse!)) {
				this._onRequest(requestOrResponse);
			} else if (this.writableEnded) {
				void this._onResponse(requestOrResponse as IncomingMessageWithTimings);
			} else {
				this.once('finish', () => {
					void this._onResponse(requestOrResponse as IncomingMessageWithTimings);
				});

				this._sendBody();
			}
		} catch (error) {
			if (error instanceof CacheableCacheError) {
				throw new CacheError(error, this);
			}

			throw error;
		}
	}

	private async _error(error: RequestError): Promise<void> {
		try {
			if (this.options && error instanceof HTTPError && !this.options.throwHttpErrors) {
				// This branch can be reached only when using the Promise API
				// Skip calling the hooks on purpose.
				// See https://github.com/sindresorhus/got/issues/2103
			} else if (this.options) {
				const hooks = this.options.hooks.beforeError;
				if (hooks.length > 0) {
					for (const hook of hooks) {
						// eslint-disable-next-line no-await-in-loop
						error = await hook(error) as RequestError;

						// Validate hook return value
						if (!(error instanceof Error)) {
							throw new TypeError(`The \`beforeError\` hook must return an Error instance. Received ${is.string(error) ? 'string' : String(typeof error)}.`);
						}
					}

					// Mark this error as processed by hooks so _destroy preserves custom error types.
					// Only mark non-RequestError errors, since RequestErrors are already preserved
					// by the instanceof check in _destroy (line 642).
					if (!(error instanceof RequestError)) {
						errorsProcessedByHooks.add(error);
					}
				}
			}
		} catch (error_: any) {
			error = new RequestError(error_.message, error_, this);
		}

		// Publish error event
		publishError({
			requestId: this._requestId,
			url: this.options?.url?.toString() ?? '',
			error,
			timings: this.timings,
		});

		this.destroy(error);

		// Manually emit error for Promise API to ensure it receives it.
		// Node.js streams may not re-emit if an error was already emitted during retry attempts.
		// Only emit for Promise API (_noPipe = true) to avoid double emissions in stream mode.
		// Use process.nextTick to defer emission and allow destroy() to complete first.
		// See https://github.com/sindresorhus/got/issues/1995
		if (this._noPipe) {
			process.nextTick(() => {
				this.emit('error', error);
			});
		}
	}

	private _writeRequest(chunk: any, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void { // eslint-disable-line @typescript-eslint/ban-types
		if (!this._request || this._request.destroyed) {
			// When there's no request (e.g., using cached response from beforeRequest hook),
			// we still need to call the callback to allow the stream to finish properly.
			callback();
			return;
		}

		this._request.write(chunk, encoding!, (error?: Error | null) => { // eslint-disable-line @typescript-eslint/ban-types
			// The `!destroyed` check is required to prevent `uploadProgress` being emitted after the stream was destroyed
			if (!error && !this._request!.destroyed) {
				this._uploadedSize += Buffer.byteLength(chunk, encoding);

				const progress = this.uploadProgress;

				if (progress.percent < 1) {
					this.emit('uploadProgress', progress);
				}
			}

			callback(error);
		});
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
		return this._aborted;
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
			total: this._responseSize,
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
			total: this._bodySize,
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
		return this._request?.reusedSocket;
	}

	/**
	Whether the stream is read-only. Returns `true` when `body`, `json`, or `form` options are provided.
	*/
	get isReadonly(): boolean {
		return !is.undefined(this.options?.body) || !is.undefined(this.options?.json) || !is.undefined(this.options?.form);
	}
}
