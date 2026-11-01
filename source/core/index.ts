import process from 'node:process';
import {Buffer} from 'node:buffer';
import {Duplex, type Readable} from 'node:stream';
import {addAbortListener, errorMonitor} from 'node:events';
import http, {ServerResponse, type ClientRequest, type RequestOptions} from 'node:http';
import {Http2ServerResponse, constants as http2Constants} from 'node:http2';
import {types, isDeepStrictEqual} from 'node:util';
import type {Socket} from 'node:net';
import {byteLength} from 'byte-counter';
import {chunk} from 'chunk-data';
import {concatUint8Arrays, stringToBase64, stringToUint8Array} from 'uint8array-extras';
import CacheableRequest, {
	CacheError as CacheableCacheError,
	type CacheableRequestFunction,
	type CacheableOptions,
} from 'cacheable-request';
import type {KeyvStoreAdapter} from 'keyv';
import type KeyvType from 'keyv';
import is, {isBuffer} from '@sindresorhus/is';
import type ResponseLike from 'responselike';
import timer, {type ClientRequestWithTimings, type Timings, type IncomingMessageWithTimings} from './utils/timer.js';
import decompressResponse from './utils/decompress-response.js';
import getBodySize from './utils/get-body-size.js';
import getConnectionHeaderTokens from './utils/get-connection-header-tokens.js';
import isNonReplayableBody from './utils/is-non-replayable-body.js';
import proxyEvents from './utils/proxy-events.js';
import timedOut, {TimeoutError as TimedOutTimeoutError, isArmableTimerDelay, timedOutRead} from './timed-out.js';
import stripUrlAuth from './utils/strip-url-auth.js';
import WeakableMap from './utils/weakable-map.js';
import calculateRetryDelay from './calculate-retry-delay.js';
import Options, {
	assertUrlHasSameOriginAsPrefixUrlIfNeeded,
	cloneRawOptions,
	crossOriginStripHeaders,
	getUrlPrefixBoundary,
	hasBodyOptionChanged,
	hasUrlOrPrefixUrlBoundaryChanged,
	isBodyUnchanged,
	isSameOrigin,
	snapshotCrossOriginState,
	type CrossOriginState,
	type StateMutations,
	type PromiseCookieJar,
	type NativeRequestOptions,
	type RetryOptions,
	type OptionsError,
	type OptionsInit,
} from './options.js';
import {
	cacheDecodedBody,
	copyRedirectDecision,
	decodeUint8Array,
	isResponseBodyless,
	isResponseOk,
	isUtf8Encoding,
	parseBody,
	type PlainResponse,
	type Response,
} from './response.js';
import isClientRequest from './utils/is-client-request.js';
import {getUnixSocketPath} from './utils/is-unix-socket-url.js';
import {
	normalizeError,
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
const singleValueRequestHeaders: ReadonlySet<string> = new Set([
	'authorization',
	'content-length',
	'host',
	'proxy-authorization',
]);

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

	__Note__: Stream responses are plain: `body` and `rawBody` are only parsed for the Promise API.
	*/
	& (<R extends PlainResponse>(name: 'response', listener: (response: R) => void) => T)

	/**
	The `redirect` event to get the options for the next request to the redirect location. The second argument is the response object of the redirect.

	This event observes options after redirect preparation. Use a `beforeRedirect` hook to change the URL, method, headers, or body for this redirect. Changes to those values in an event listener are not supported because they occur after validation and preparation of derived headers.
	*/
	& (<R extends PlainResponse, N extends Options>(name: 'redirect', listener: (nextOptions: N, response: R) => void) => T)

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

type StorageAdapter = KeyvStoreAdapter | KeyvType | Map<unknown, unknown>;

const cacheableStore = new WeakableMap<string | StorageAdapter, CacheableRequestFunction>();

const redirectCodes: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
export {crossOriginStripHeaders} from './options.js';
const transientWriteErrorCodes: ReadonlySet<string> = new Set(['EPIPE', 'ECONNRESET']);
// See https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
const hopByHopHeaders: ReadonlySet<string> = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);
const omittedPipedHeaders: ReadonlySet<string> = new Set([
	...hopByHopHeaders,
	'host',
	'authorization',
	'cookie',
	'cookie2',
	'set-cookie',
	'set-cookie2',
]);

const proxiedRequestEvents = [
	'socket',
	'connect',
	'continue',
	'information',
	'upgrade',
] as const;

const noop = (): void => {};

// Both the HTTP/1 and the HTTP/2 server responses get the status and headers copied in, so Got
// owns ending them.
type PipedServerResponse = ServerResponse | Http2ServerResponse;

const isPipedServerResponse = (destination: NodeJS.WritableStream): destination is PipedServerResponse => destination instanceof ServerResponse
	|| destination instanceof Http2ServerResponse;

const destroyRequestResult = (result: unknown): void => {
	if (!is.object(result) || !('destroy' in result) || !is.function(result.destroy)) {
		return;
	}

	if ('once' in result && is.function(result.once)) {
		result.once('error', noop);
	}

	result.destroy();
};

const createPreRequestErrorTimings = (): Timings => {
	const now = Date.now();

	return {
		start: now,
		error: now,
		phases: {
			total: 0,
		},
	};
};

type NativeFormDataBodyMetadata = {
	form: FormData;
	body: ReadableStream;
	// Header absence can also mean an explicit omission that must survive later replays.
	contentTypeWasGenerated: boolean;
};

type IterableBodySource = {
	body: Iterable<unknown> | AsyncIterable<unknown>;
	iterator: Iterator<unknown> | AsyncIterator<unknown> | undefined;
};

type BodySource = IterableBodySource | {
	body: ReadableStream;
	reader: ReadableStreamDefaultReader | undefined;
};

const serializeNativeFormDataBody = (form: FormData) => {
	const response = new globalThis.Response(form);
	return {
		body: response.body!,
		contentType: response.headers.get('content-type') ?? 'multipart/form-data',
	};
};

const isTransientWriteError = (error: Error): boolean => {
	const {code} = error;
	return typeof code === 'string' && transientWriteErrorCodes.has(code);
};

/**
Copies headers and their array values without changing names or values.
*/
const cloneHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]));

const getConnectionListedHeaders = (headers: Record<string, string | string[] | undefined>): Set<string> => {
	const connectionListedHeaders = new Set<string>();

	for (const [header, connectionHeader] of Object.entries(headers)) {
		const normalizedHeader = header.toLowerCase();

		if (normalizedHeader !== 'connection' && normalizedHeader !== 'proxy-connection') {
			continue;
		}

		for (const token of getConnectionHeaderTokens(connectionHeader)) {
			connectionListedHeaders.add(token);
		}
	}

	return connectionListedHeaders;
};

type UrlType = ConstructorParameters<typeof Options>[0];
type OptionsType = ConstructorParameters<typeof Options>[1];
type DefaultsType = ConstructorParameters<typeof Options>[2];
const getSanitizedUrl = (options?: Options): string => options?.url ? stripUrlAuth(options.url) : '';

const methodCanHaveBody = (options: Options): boolean => !methodsWithoutBody.has(options.method) || (options.method === 'GET' && options.allowGetBody);

const makeProgress = (transferred: number, total?: number): Progress => {
	let percent = 0;
	if (total === transferred) {
		// Known-size complete transfers (including 0/0) should report 100% rather than 0%.
		percent = 1;
	} else if (total) {
		percent = transferred / total;
	}

	return {percent, transferred, total};
};

const parseContentLength = (value: unknown): number | undefined => {
	const length = Number(value);
	return Number.isNaN(length) ? undefined : length;
};

const hasBodyOption = (options: Options | undefined): boolean => !is.undefined(options?.body) || !is.undefined(options?.json) || !is.undefined(options?.form);

const isIterableBody = (body: unknown): body is Iterable<unknown> | AsyncIterable<unknown> => is.asyncIterable(body) || (is.iterable(body) && !is.string(body) && !isBuffer(body));

const hasResponse = (request: ClientRequest): boolean => Boolean((request as ClientRequest & {res?: unknown}).res);

const toRequestError = (thrown: unknown, request: Request, response?: PlainResponse): RequestError => {
	const normalizedError = normalizeError(thrown);
	return new RequestError(normalizedError.message, thrown, request, response);
};

const createServerAbortedError = (request: Request): ReadError => new ReadError({
	name: 'Error',
	message: 'The server aborted pending request',
	code: 'ECONNRESET',
}, request);

export default class Request extends Duplex implements RequestEvents<Request> {
	// @ts-expect-error - Ignoring for now.
	override ['constructor']: typeof Request;

	_noPipe?: boolean;

	// @ts-expect-error https://github.com/microsoft/TypeScript/issues/9568
	options: Options;
	response?: PlainResponse;
	requestUrl?: URL;
	redirectUrls: URL[];
	retryCount = 0;
	_stopReading = false;

	declare private _requestOptions: NativeRequestOptions;

	private _stopRetry?: () => void;
	private _downloadedSize = 0;
	private _uploadedSize = 0;
	private readonly _pipedServerResponses = new Set<PipedServerResponse>();
	private _preparePipedServerResponse?: (destination: PipedServerResponse) => void;
	private _request?: ClientRequest;
	private _responseSize?: number;
	private _bodySize?: number;
	private _bodyErrorStream?: NodeJS.EventEmitter;
	private _nativeFormDataBody?: NativeFormDataBodyMetadata;
	private _bodySource?: BodySource;
	private _unproxyEvents?: () => void;
	private _triggerRead = false;
	// We need this because `this._request` is undefined when using cache. An absent queue means initialization is no longer pending.
	private _jobs: Array<{run: () => void; cancel: (error: Error) => void}> | undefined = [];
	private _cancelTimeouts?: () => void;
	private _abortListenerDisposer?: {[Symbol.dispose](): void};
	private _flushed = false;
	private _startedAt?: number;
	private _requestTimeout?: NodeJS.Timeout;
	private _dispatchedBody?: {body: unknown};
	private _aborted = false;
	private _retrying = false;
	// Track the terminal error owned by this request so beforeError hooks can preserve custom error types.
	private _beforeErrorResult?: Error;
	private _expectedContentLength?: number;
	private _compressedBytesCount?: number;
	private _skipRequestEndInFinal = false;
	private _hasWrittenBody = false;
	private _hasWritableBody = false;
	private _discardBodyWrites = false;
	private _incrementalDecode?: {decoder: TextDecoder; chunks: string[]};
	private readonly _requestId: string;
	private readonly _previousRedirectCount: number;

	constructor(url: UrlType, options?: OptionsType, defaults?: DefaultsType, retrySource?: Request) {
		super({
			// Don't destroy immediately, as the error may be emitted on unsuccessful retry
			autoDestroy: false,
			// It needs to be zero because we're just proxying the data to another stream
			highWaterMark: 0,
		});
		this._requestId = retrySource?._requestId ?? generateRequestId();
		this.redirectUrls = retrySource ? [...retrySource.redirectUrls] : [];
		// History spans retries, while redirect limits and dispatch state belong to this attempt.
		this._previousRedirectCount = this.redirectUrls.length;

		// Observe the terminal error without consuming unhandled stream errors.
		const onError = (error: Error) => {
			// The Promise API routes writable errors through retry and beforeError hooks first.
			if (this._noPipe && !this.destroyed) {
				return;
			}

			this.off(errorMonitor, onError);
			publishError(() => ({
				requestId: this._requestId,
				url: getSanitizedUrl(this.options),
				error,
				timings: this.timings,
			}));
		};

		this.on(errorMonitor, onError);

		this.on('pipe', (source: NodeJS.ReadableStream & {headers?: Record<string, string | string[] | undefined>}) => {
			if (this.options.copyPipedHeaders && source?.headers) {
				const connectionListedHeaders = getConnectionListedHeaders(source.headers);

				for (const [header, value] of Object.entries(source.headers)) {
					const normalizedHeader = header.toLowerCase();

					if (omittedPipedHeaders.has(normalizedHeader) || connectionListedHeaders.has(normalizedHeader) || !this.options.shouldCopyPipedHeader(normalizedHeader)) {
						continue;
					}

					this.options.setPipedHeader(normalizedHeader, value);
				}
			}
		});

		this.on('newListener', event => {
			if (event === 'retry' && this.listenerCount('retry') > 0) {
				throw new Error('A retry listener has been attached already.');
			}
		});

		try {
			this.options = new Options(url, options, defaults);
			const previousFormDataBody = retrySource?._nativeFormDataBody;
			// Multipart provenance belongs to the serialized body, not a replacement payload.
			if (previousFormDataBody?.body === this.options.body) {
				this._nativeFormDataBody = previousFormDataBody;
			}

			if (!this.options.url) {
				if (this.options.prefixUrl === '') {
					throw new TypeError('Missing `url` property');
				}

				this.options.url = '';
			}

			this.requestUrl = new URL(retrySource?.requestUrl ?? this.options.url!);

			// Publish request creation event
			publishRequestCreate(() => ({
				requestId: this._requestId,
				url: getSanitizedUrl(this.options),
				method: this.options.method,
			}));
		} catch (error: unknown) {
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
						const normalizedError = normalizeError(error);
						const requestError = normalizedError instanceof RequestError ? normalizedError : new RequestError(normalizedError.message, error, this);
						this.destroy(requestError);
					}
				});
			};

			return;
		}

		// Important! If you replace `body` in a handler with another stream, make sure it's readable first.
		// Observe early errors, then transfer the subscription when handlers or hooks replace the body.
		this._attachBodyErrorListener(this.options.body);
	}

	async flush() {
		if (this._flushed) {
			return;
		}

		this._flushed = true;

		try {
			this._attachAbortListener();

			if (this.destroyed) {
				return;
			}

			this._attachBodyErrorListener(this.options.body);
			await this._finalizeBody();

			if (this.destroyed) {
				return;
			}

			this._hasWritableBody = this._canWriteBody();

			await this._makeRequest();

			if (this.destroyed) {
				this._request?.destroy();
				return;
			}

			// Queued writes etc.
			while (this._jobs?.length) {
				this._jobs.shift()!.run();
			}

			// Prevent memory leak
			this._jobs = undefined;
		} catch (error: unknown) {
			this._beforeError(error);
		}
	}

	_beforeError(thrown: unknown): void {
		if (this._stopReading) {
			return;
		}

		let error = normalizeError(thrown);
		const {response, options} = this;
		const attemptCount = this.retryCount + 1;

		this._stopReading = true;

		if (error instanceof TimedOutTimeoutError) {
			error = this._createTimeoutError(error);
		} else if (!(error instanceof RequestError)) {
			error = new RequestError(error.message, thrown, this);
		}

		const typedError = error as RequestError;

		void (async () => {
			// Node.js parser is really weird.
			// It emits post-request Parse Errors on the same instance as previous request. WTF.
			// Therefore, we need to check if it has been destroyed as well.
			if (response?.readable && !response.rawBody && !this._request?.socket?.destroyed) {
				await this._setRawBody(response);
			}

			if (!this.destroyed && response?.rawBody && response.body === undefined) {
				try {
					// `error.response` is typed with the request's `responseType`, so honour it here. The
					// body is assigned right below, so the cast is only visible while parsing.
					response.body = parseBody(response as Response, options.responseType, options.parseJson, options.encoding);
				} catch {
					// Preserve the original request error when parsing its response body also fails.
					try {
						response.body = decodeUint8Array(response.rawBody, options.encoding);
					} catch {}
				}
			}

			if (this.destroyed) {
				return;
			}

			if (this.listenerCount('retry') !== 0) {
				let backoff: number;

				try {
					let retryAfter;
					if (response && 'retry-after' in response.headers) {
						const retryAfterHeader = response.headers['retry-after']!;
						if (/^\d+$/v.test(retryAfterHeader)) {
							retryAfter = Number(retryAfterHeader) * 1000;
						} else if (Number.isNaN(Number(retryAfterHeader))) {
							// The asctime HTTP-date format has no timezone marker, but represents UTC (RFC 9110, section 5.6.7).
							const date = /^\w{3} \w{3} [\d ]\d \d{2}:\d{2}:\d{2} \d{4}$/v.test(retryAfterHeader) ? `${retryAfterHeader} GMT` : retryAfterHeader;
							retryAfter = Date.parse(date) - Date.now();
						}

						if (retryAfter === undefined || Number.isNaN(retryAfter)) {
							// Invalid `Retry-After` values must be ignored. See https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
							retryAfter = undefined;
						} else if (retryAfter < 0) {
							retryAfter = 0;
						}
					}

					const retryOptions = options.retry as RetryOptions;

					const computedValue = calculateRetryDelay({
						attemptCount,
						retryOptions,
						error: typedError,
						retryAfter,
						computedValue: retryOptions.maxRetryAfter ?? options.timeout.request ?? Infinity,
					});

					// When enforceRetryRules is true, respect the retry rules (limit, methods, statusCodes, errorCodes)
					// before calling the user's calculateDelay function. If computedValue is 0 (meaning retry is not allowed
					// based on these rules), skip calling calculateDelay entirely.
					// When false, always call calculateDelay, allowing it to override retry decisions.
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
				} catch (error_: unknown) {
					if (!this.destroyed) {
						void this._error(toRequestError(error_, this));
					}

					return;
				}

				// A retry calculation can finish after cancellation has destroyed this request.
				if (this.destroyed) {
					return;
				}

				// Node turns overflowing timer delays into 1 ms. Stop retrying instead of running before the requested delay.
				if (backoff && backoff <= 2_147_483_647) {
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
					const boundaryBeforeRetryHooks = getUrlPrefixBoundary(this.options);
					const urlBeforeRetryHooks = this.options.hooks.beforeRetry.length > 0 ? boundaryBeforeRetryHooks.url : undefined;
					const stateBeforeRetryHooks = urlBeforeRetryHooks ? snapshotCrossOriginState(this.options) : undefined;

					let changedState: StateMutations;

					try {
						changedState = await this.options.trackStateMutations(async changedState => {
							for (const hook of this.options.hooks.beforeRetry) {
								// eslint-disable-next-line no-await-in-loop
								await hook(typedError, this.retryCount + 1);
								if (this.destroyed) {
									break;
								}
							}

							return changedState;
						});

						// Cancellation during an async hook leaves this attempt without a retry.
						if (this.destroyed) {
							return;
						}

						this.options.applyNextRequestMutations(boundaryBeforeRetryHooks, stateBeforeRetryHooks, changedState);
					} catch (error_: unknown) {
						if (!this.destroyed) {
							void this._error(toRequestError(error_, this));
						}

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
					/*
					The retry handoff destroys this request. A failure afterward leaves it without a next attempt, so this request still owns closing the piped destination and reporting the error.
					*/
					try {
						if (hasBodyOptionChanged(changedState)) {
							this.options.resetUnchangedBodyHeaders(changedState);
						}

						this._retrying = true;

						if (bodyWasReassigned) {
							const oldBody = bodyBeforeHooks;
							// Temporarily clear body to prevent destroy() from destroying the new stream
							this.options.body = undefined;
							this.destroy();

							// `_destroy` already tore down the dispatched body, so only clean up a
							// different one here.
							if (oldBody !== bodyAfterHooks && oldBody !== this._dispatchedBody?.body) {
								this._destroyBody(oldBody);
							}

							// Restore new body for promise wrapper's identity check
							if (is.nodeStream(bodyAfterHooks) && (bodyAfterHooks.readableEnded || bodyAfterHooks.destroyed)) {
								throw new TypeError('The reassigned stream body must be readable. Ensure you provide a fresh, readable stream in the beforeRetry hook.');
							}

							this.options.body = bodyAfterHooks;
						} else {
							// Body wasn't reassigned - use normal destroy flow which handles body cleanup
							this.destroy();
							// Note: We do NOT restore the body reference here. The stream was destroyed by _destroy()
							// and should not be accessed. The promise wrapper will see that body identity hasn't changed
							// and will detect it's a consumed stream, which is the correct behavior.
						}

						// Native FormData can be re-serialized, so replay it instead of failing with a consumed body.
						if (this._nativeFormDataBody !== undefined && this.options.body === this._nativeFormDataBody.body) {
							this._reserializeFormDataBody(this.options, changedState.headers.has('content-type'));
						}

						// Publish retry event
						publishRetry(() => ({
							requestId: this._requestId,
							retryCount: this.retryCount + 1,
							error: typedError,
							delay: backoff,
						}));

						this.emit('retry', this.retryCount + 1, error, (updatedOptions?: OptionsInit) => {
							const request = new Request(undefined, undefined, options, this);
							request.retryCount = this.retryCount + 1;

							try {
								if (updatedOptions !== undefined) {
									const nextOptions = updatedOptions instanceof Options ? updatedOptions : cloneRawOptions(updatedOptions);
									const previousBoundary = getUrlPrefixBoundary(request.options);
									request.options.mergeNextRequestOptions(nextOptions, {
										previousUrl: previousBoundary.url,
										previousState: snapshotCrossOriginState(request.options),
										previousBoundary,
									});
								}
							} catch (error) {
								// The next attempt owns any accepted replacement body, also when its update fails validation.
								process.nextTick(() => {
									request._beforeError(error);
								});
								return request;
							} finally {
								request._attachBodyErrorListener(request.options.body);
							}

							process.nextTick(() => {
								void request.flush();
							});

							return request;
						});
					} catch (error_: unknown) {
						// A failed retry handoff can leave a new body on an already destroyed request. Nothing dispatched it, so this rollback owns its cleanup. Before destruction, `_destroy` owns it instead.
						if (this.destroyed && this.options.body !== this._dispatchedBody?.body) {
							this._destroyBody(this.options.body);
						}

						this._closePipedServerResponses();
						void this._error(toRequestError(error_, this));
						return;
					}

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
				if (this._noPipe && typeof data === 'string') {
					data = Buffer.from(data, response.readableEncoding ?? undefined);
				}

				this._downloadedSize += typeof data === 'string' ? Buffer.byteLength(data, response.readableEncoding ?? undefined) : byteLength(data);

				if (this._incrementalDecode) {
					try {
						const decodedChunk = typeof data === 'string' ? data : this._incrementalDecode.decoder.decode(data, {stream: true});
						if (decodedChunk.length > 0) {
							this._incrementalDecode.chunks.push(decodedChunk);
						}
					} catch {
						this._incrementalDecode = undefined;
					}
				}

				const progress = this.downloadProgress;

				if (progress.percent < 1) {
					this._emitProgress('downloadProgress', progress);
				}

				if (this._stopReading || !this.push(data) || this._stopReading) {
					return;
				}
			}
		}
	}

	// Fail at the call site: a write buffered by `cork()` must be refused before entering the writable queue.
	override write(chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean { // eslint-disable-line @typescript-eslint/no-restricted-types
		if (this.isReadonly) {
			const error = new TypeError('The stream is read-only: the request body is provided by the `body`, `json` or `form` option.');
			this.destroy(error);

			// Like a write to a destroyed stream, the refused write still reports to its callback.
			const writeCallback = typeof encoding === 'function' ? encoding : callback;
			if (writeCallback) {
				process.nextTick(writeCallback, error);
			}

			return false;
		}

		return super.write(chunk, encoding as BufferEncoding, callback);
	}

	override _write(chunk: unknown, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void { // eslint-disable-line @typescript-eslint/no-restricted-types
		const write = (): void => {
			if (this._discardBodyWrites) {
				callback();
				return;
			}

			// The `body`, `json` or `form` option owns the request body, so a user write would land
			// past the framed `content-length` and corrupt the request.
			if (this.isReadonly) {
				callback(new TypeError('The stream is read-only: the request body is provided by the `body`, `json` or `form` option.'));
				return;
			}

			this._hasWrittenBody = true;
			this._writeRequest(chunk, encoding, callback);
		};

		if (this._jobs) {
			this._jobs.push({run: write, cancel: callback});
		} else {
			write();
		}
	}

	override _final(callback: (error?: Error | null) => void): void { // eslint-disable-line @typescript-eslint/no-restricted-types
		const endRequest = (): void => {
			if (this._discardBodyWrites) {
				this._hasWritableBody = false;
				callback();
				return;
			}

			if (this._skipRequestEndInFinal) {
				this._skipRequestEndInFinal = false;
				callback();
				return;
			}

			const request = this._request;

			// We need to check if `this._request` is present,
			// because it isn't when we use cache.
			if (!request || request.destroyed) {
				this._hasWritableBody = false;
				callback();
				return;
			}

			const onEnd = (error?: Error | null) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				// The request has been destroyed before `_final` finished.
				// See https://github.com/nodejs/node/issues/39356
				if ((request as any)?._writableState?.errored) {
					return;
				}

				this._hasWritableBody = false;

				if (error && this._request === request) {
					// `ClientRequest.end()` can report the same failure as the request's `error` event. Route it through Got's retry handling without completing `_final`, so this Duplex does not finish a failed upload.
					this._beforeError(error);
					return;
				}

				this._emitUploadComplete(request);
				callback();
			};

			// A custom transport can finish its upload before Got adopts the native request.
			if (request.writableFinished) {
				onEnd();
			} else {
				request.end(onEnd);
			}
		};

		if (this._jobs) {
			this._jobs.push({run: endRequest, cancel: callback});
		} else {
			endRequest();
		}
	}

	override _destroy(error: Error | null, callback: (error: Error | null) => void): void { // eslint-disable-line @typescript-eslint/no-restricted-types
		this._stopReading = true;
		this.flush = async () => {};

		// Got owns a piped `ServerResponse`: it copied the status code and headers into it, so a
		// request that fails would leave the client waiting forever. A retry only replaces the
		// request, so the destination belongs to whichever attempt comes next. Node emits `close`
		// after `error`, so an `error` listener can still answer the client itself, such as with a
		// 502, and only a destination nobody ended is closed.
		if (!this._retrying) {
			this.once('close', () => {
				this._closePipedServerResponses();
			});
		}

		// Prevent further retries
		this._stopRetry?.();
		this._cancelTimeouts?.();
		clearTimeout(this._requestTimeout);
		this._detachAbortListener();
		this._attachBodyErrorListener(undefined);
		this._destroyInFlightAlpnSocket();

		if (this.options) {
			// Tear down the body this request dispatched, or the original body if dispatch never started. A hook can install a different body before destruction, and only an actual retry handoff transfers ownership to the next attempt.
			const ownedBody = this._dispatchedBody === undefined ? this.options.body : this._dispatchedBody.body;
			this._destroyBody(ownedBody);

			if (!this._retrying && this.options.body !== ownedBody) {
				// Nothing dispatched the current body, so a terminal request still owns it.
				this._destroyBody(this.options.body);
			}
		}

		destroyRequestResult(this._request ?? this.response);

		// Workaround: http-timer only sets timings.end when the response emits 'end'.
		// When a stream is destroyed before completion, the 'end' event may not fire,
		// leaving timings.end undefined. This should ideally be fixed in http-timer
		// by listening to the 'close' event, but we handle it here for now.
		// Only use the fallback when neither a native failure nor an explicit abort has been recorded.
		const timings = (this._request as ClientRequestWithTimings)?.timings;
		if (timings && !this._aborted && is.undefined(timings.end) && !is.undefined(timings.response) && is.undefined(timings.error) && is.undefined(timings.abort)) {
			timings.end = Date.now();
			if (is.undefined(timings.phases.total)) {
				timings.phases.download = timings.end - timings.response;
				timings.phases.total = timings.end - timings.start;
			}
		}

		const jobs = this._jobs;
		this._jobs = undefined;
		if (jobs) {
			const initializationError = error ?? Object.assign(new Error('The stream was destroyed before initialization completed'), {code: 'ERR_STREAM_DESTROYED'});

			for (const job of jobs) {
				job.cancel(initializationError);
			}
		}

		// Preserve custom errors returned by beforeError hooks.
		// For other errors, wrap non-RequestError instances for consistency.
		if (error !== null && error !== this._beforeErrorResult && !(error instanceof RequestError)) {
			error = toRequestError(error, this);
		}

		callback(error);
	}

	override pipe<T extends NodeJS.WritableStream>(destination: T, options?: {end?: boolean}): T {
		if (isPipedServerResponse(destination)) {
			this._pipedServerResponses.add(destination);
			this._preparePipedServerResponse?.(destination);
		}

		return super.pipe(destination, options);
	}

	override unpipe<T extends NodeJS.WritableStream>(destination?: T): this {
		if (destination === undefined) {
			this._pipedServerResponses.clear();
		} else if (isPipedServerResponse(destination)) {
			this._pipedServerResponses.delete(destination);
		}

		super.unpipe(destination);

		return this;
	}

	// Got copied the status code and headers into every `ServerResponse` it is piped into, so it
	// owns the response and has to end it. A request that ends without one leaves the client
	// waiting forever.
	private _closePipedServerResponses(): void {
		for (const destination of this._pipedServerResponses) {
			if (destination.writableEnded) {
				continue;
			}

			// An HTTP/2 stream destroyed without an error is reset with `NO_ERROR`, which the client
			// reads as a complete response, so the failure has to be in the reset code.
			if (destination instanceof Http2ServerResponse) {
				destination.stream.close(http2Constants.NGHTTP2_INTERNAL_ERROR);
			} else {
				destination.destroy();
			}
		}

		this._pipedServerResponses.clear();
	}

	/**
	Disposes the request's current abort subscription.
	*/
	private _detachAbortListener(): void {
		this._abortListenerDisposer?.[Symbol.dispose]();
		this._abortListenerDisposer = undefined;
	}

	private _attachAbortListener(): void {
		this._detachAbortListener();
		if (this.destroyed) {
			return;
		}

		const {signal} = this.options;
		if (!signal) {
			return;
		}

		const abort = () => {
			this._aborted = true;
			this._destroyInFlightAlpnSocket();

			// See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static#return_value
			if (signal.reason?.name === 'TimeoutError') {
				this.destroy(this._createTimeoutError(signal.reason));
			} else {
				this.destroy(new AbortError(this));
			}
		};

		if (signal.aborted) {
			abort();
		} else {
			this._abortListenerDisposer = addAbortListener(signal, abort);
		}
	}

	private _createTimeoutError(error: TimedOutTimeoutError): TimeoutError {
		return new TimeoutError(error, this.timings ?? createPreRequestErrorTimings(), this);
	}

	private _destroyInFlightAlpnSocket(): void {
		(this._requestOptions as (NativeRequestOptions & {_alpnSocket?: Socket}) | undefined)?._alpnSocket?.destroy();
	}

	private _shouldIncrementallyDecodeBody(): boolean {
		const {responseType, encoding} = this.options;

		return Boolean(this._noPipe)
			&& (responseType === 'text' || responseType === 'json')
			&& isUtf8Encoding(encoding);
	}

	private _checkContentLengthMismatch(): boolean {
		if (this.options.strictContentLength && this._expectedContentLength !== undefined) {
			// Use compressed bytes count when available (for compressed responses),
			// otherwise use _downloadedSize (for uncompressed responses)
			const actualSize = this._compressedBytesCount ?? this._downloadedSize;
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

	// A `beforeRequest` or `beforeRedirect` hook can assign a `FormData` body, and only this
	// place turns one into a stream, so it runs again once the hooks have had their say.
	private _serializeFormDataBody(options: Options, contentTypeChanged: boolean): void {
		if (!(options.body instanceof FormData)) {
			return;
		}

		const headers = options.getInternalHeaders();
		const {body, contentType} = serializeNativeFormDataBody(options.body);

		// Every serialization picks a new boundary, so a header Got generated for an earlier one
		// no longer names it. Only a header the caller set itself survives.
		const contentTypeWasGenerated = !contentTypeChanged && (is.undefined(headers['content-type']) || this._nativeFormDataBody?.contentTypeWasGenerated === true);

		this._nativeFormDataBody = {
			form: options.body,
			body,
			contentTypeWasGenerated,
		};

		if (contentTypeWasGenerated) {
			options.setGeneratedHeader('content-type', contentType);
		}

		options.body = body;
	}

	private async _finalizeBody(): Promise<void> {
		const {options} = this;
		const headers = options.getInternalHeaders();

		const isForm = !is.undefined(options.form);
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const isJSON = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		const cannotHaveBody = !methodCanHaveBody(options);

		if (isForm || isJSON || isBody) {
			if (cannotHaveBody) {
				throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
			}

			// Serialize body
			const noContentType = is.undefined(headers['content-type']);

			if (isBody) {
				if (Object.prototype.toString.call(options.body) === '[object FormData]' && !(options.body instanceof FormData)) {
					throw new TypeError('Non-native FormData is not supported. Use globalThis.FormData instead.');
				}

				this._serializeFormDataBody(options, false);
			} else if (isForm) {
				if (noContentType) {
					options.setGeneratedHeader('content-type', 'application/x-www-form-urlencoded');
				}

				const {form} = options;
				options.form = undefined;

				options.body = (new URLSearchParams(form)).toString();
			} else {
				if (noContentType) {
					options.setGeneratedHeader('content-type', 'application/json');
				}

				const {json} = options;
				options.json = undefined;

				options.body = options.stringifyJson(json);
			}

			const uploadBodySize = getBodySize(options.body, headers);

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

		if (options.responseType === 'json' && !('accept' in headers)) {
			headers.accept = 'application/json';
		}

		this._bodySize = parseContentLength(headers['content-length']);
	}

	private async _onResponseBase(response: IncomingMessageWithTimings): Promise<void> {
		// This will be called e.g. when using cache so we need to check if this request has stopped.
		if (this._stopReading) {
			return;
		}

		const {options} = this;
		const {url} = options;

		const nativeResponse = response as IncomingMessageWithTimings & {fromCache?: boolean};
		const statusCode = response.statusCode!;
		const {method} = options;
		const redirectLocationHeader = response.headers.location;
		const redirectLocation = Array.isArray(redirectLocationHeader) ? redirectLocationHeader[0] : redirectLocationHeader;
		const isRedirect = Boolean(redirectLocation && redirectCodes.has(statusCode));

		// Skip decompression for responses that must not have bodies per RFC 9110:
		// - HEAD responses (any status code)
		// - 1xx (Informational): 100, 101, 102, 103, etc.
		// - 204 (No Content)
		// - 205 (Reset Content)
		// - 304 (Not Modified)
		const hasNoBody = isResponseBodyless(method, statusCode);

		const prepareResponse = (response: PlainResponse): PlainResponse => {
			if (!Object.hasOwn(response, 'headers')) {
				Object.defineProperty(response, 'headers', {
					value: response.headers,
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}

			response.statusMessage ||= http.STATUS_CODES[statusCode]; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- The status message can be empty.
			response.url = stripUrlAuth(options.url!);
			response.requestUrl = this.requestUrl!;
			response.redirectUrls = this.redirectUrls;
			response.request = this;
			response.isFromCache = nativeResponse.fromCache ?? false;
			response.ip = this.ip;
			response.retryCount = this.retryCount;

			return response;
		};

		// A response from an earlier attempt or redirect hop is not this response. `_beforeError`
		// must not buffer its body or read its `retry-after` when this response is rejected.
		this.response = undefined;
		let typedResponse = prepareResponse(response as PlainResponse);
		this.response = typedResponse;
		if (options.timeout.read !== undefined) {
			// Responses returned directly by a custom transport have the same read budget as native request responses.
			const cancelRequestTimeouts = this._cancelTimeouts;
			const cancelReadTimeout = timedOutRead(response, options.timeout.read, error => {
				this._expireTimeout(error);
			});
			this._cancelTimeouts = () => {
				cancelReadTimeout();
				cancelRequestTimeouts?.();
			};
		}

		try {
			typedResponse.ok = isResponseOk(typedResponse);
		} catch (error) {
			destroyRequestResult(response);
			this.response = undefined;
			throw error;
		}

		if (this._stopReading) {
			return;
		}

		// Redirect responses that will be followed are drained raw. Decompressing them can
		// turn an irrelevant redirect body into a client-side failure or decompression DoS.
		// The redirect predicate was already evaluated above.
		const shouldFollowRedirect = isRedirect && !typedResponse.ok;

		if (options.decompress && !hasNoBody && !shouldFollowRedirect) {
			try {
				response = decompressResponse(response);
			} catch (error: unknown) {
				// The body stays unread. Release the response, because a custom request function's
				// response is not tied to `this._request`, which `_destroy` tears down.
				destroyRequestResult(response);
				// A destroyed response no longer reads, so `_beforeError` keeps its body unread.
				// A cached response can already carry the raw body, so clear it as well. Revalidated cached responses expose `body` through a nonconfigurable accessor.
				typedResponse.body = undefined;
				typedResponse.rawBody = undefined;
				this.response = typedResponse;
				throw toRequestError(error, this);
			}

			const decodedResponse = prepareResponse(response as PlainResponse);
			copyRedirectDecision(typedResponse, decodedResponse);
			decodedResponse.ok = typedResponse.ok;
			typedResponse = decodedResponse;

			// When strictContentLength is enabled, track the compressed bytes emitted by the native response.
			if (options.strictContentLength && response !== nativeResponse) {
				this._compressedBytesCount = 0;
				nativeResponse.on('data', (chunk: Uint8Array) => {
					this._compressedBytesCount! += byteLength(chunk);
				});
			}
		}

		// `decompressResponse` wraps the response stream when it decompresses,
		// so `response !== nativeResponse` indicates decompression happened.
		const wasDecompressed = response !== nativeResponse;

		this._responseSize = parseContentLength(response.headers['content-length']);

		this.response = typedResponse;

		this._incrementalDecode = this._shouldIncrementallyDecodeBody() ? {decoder: new TextDecoder(), chunks: []} : undefined;

		// Publish response start event. A subscriber gets a copy, so it cannot change the response.
		publishResponseStart(() => ({
			requestId: this._requestId,
			url: typedResponse.url,
			statusCode,
			headers: cloneHeaders(response.headers),
			isFromCache: typedResponse.isFromCache,
		}));

		response.once('error', (error: Error) => {
			// A followed redirect response no longer owns this request.
			// Node synthesizes ECONNRESET for close-delimited responses after all body
			// bytes have been delivered. Only ignore that late synthetic error on the
			// native response. Wrapped decompression streams surface real checksum and
			// truncation failures after the underlying response has completed.
			if (
				this.response !== typedResponse
				|| (
					!wasDecompressed
					&& response.complete
					&& this._responseSize === undefined
					&& error.code === 'ECONNRESET'
				)
			) {
				return;
			}

			this._aborted = true;

			this._beforeError(new ReadError(error, this));
		});

		const onResponseAborted = () => {
			if (this.response !== typedResponse) {
				return;
			}

			this._aborted = true;
			// A wrapper can forward `close` while still readable, so stop it before error handling tries to capture its body.
			response.destroy();

			// Check if there's a content-length mismatch to provide a more specific error
			if (!this._checkContentLengthMismatch()) {
				this._beforeError(createServerAbortedError(this));
			}
		};

		response.once('aborted', () => {
			// Without Content-Length, connection close is the intended EOF signal (RFC 9110 §8.6),
			// not a premature abort. For wrapped decompression streams, rely on the native
			// response completion state because the wrapper strips `content-length`.
			if (this._responseSize === undefined && nativeResponse.complete) {
				return;
			}

			onResponseAborted();
		});
		response.once('close', () => {
			// Synthetic responses can close without `aborted` and declare `complete` before reading starts. An existing source error owns failure propagation through a decoder.
			if ((response.readableAborted || nativeResponse.readableAborted) && !response.errored && !nativeResponse.errored) {
				onResponseAborted();
			}
		});

		let canFinalizeResponse = false;
		const handleResponseEnd = () => {
			if (
				!canFinalizeResponse
				|| !response.readableEnded
			) {
				return;
			}

			canFinalizeResponse = false;

			if (this._stopReading) {
				return;
			}

			// Validate content-length if it was provided
			// Per RFC 9112: "If the sender closes the connection before the indicated number
			// of octets are received, the recipient MUST consider the message to be incomplete"
			// The guards stay apart: merging them would skip this check whenever reading stopped.
			// eslint-disable-next-line unicorn/prefer-combined-guards
			if (this._checkContentLengthMismatch()) {
				return;
			}

			this._responseSize = this._downloadedSize;
			this._emitProgress('downloadProgress', this.downloadProgress);
			if (this._stopReading) {
				return;
			}

			/*
			A stream request is never destroyed once it ends, so its abort listener would
			outlive it and a shared signal firing later would destroy a finished request. The
			promise API disposes it when the request itself is destroyed, which must not
			happen before the `afterResponse` hooks have run.
			*/
			if (!this._noPipe) {
				if (this.writableFinished) {
					this._detachAbortListener();
				} else {
					this.prependOnceListener('finish', this._detachAbortListener);
				}
			}

			// Publish response end event
			publishResponseEnd(() => ({
				requestId: this._requestId,
				url: typedResponse.url,
				statusCode,
				bodySize: this._downloadedSize,
				timings: this.timings,
			}));

			this.push(null);
		};

		if (!shouldFollowRedirect) {
			// The request budget ends with the final response body.
			response.once('end', () => {
				clearTimeout(this._requestTimeout);
			});

			// `set-cookie` handling below awaits the cookie jar. A fast response can fully
			// end during that await, so we need to observe `end` early without completing
			// the outward stream until cookie handling has finished.
			response.once('end', handleResponseEnd);
		}

		const rawCookies = response.headers['set-cookie'];
		const responseRawBodyPromise = this._noPipe
			&& is.object(options.cookieJar)
			&& rawCookies !== undefined
			&& !shouldFollowRedirect
			? this._setRawBody(response)
			: undefined;

		// A response served from the cache must not re-apply `set-cookie` to the cookie jar.
		// Both a cache hit and a revalidated response arrive marked as cache-served, so only a response that did not come from the cache may update the jar.
		if (!typedResponse.isFromCache && is.object(options.cookieJar) && rawCookies) {
			try {
				// Apply fields in wire order so asynchronous stores cannot restore a replaced cookie.
				for (const rawCookie of rawCookies) {
					if (this._stopReading) {
						break;
					}

					try {
						// eslint-disable-next-line no-await-in-loop
						await (options.cookieJar as PromiseCookieJar).setCookie(rawCookie, url!.toString());
					} catch (error) {
						if (!options.ignoreInvalidCookies) {
							throw error;
						}
					}
				}
			} catch (error: unknown) {
				if (responseRawBodyPromise) {
					await responseRawBodyPromise;
				}

				this._beforeError(error);
				return;
			}
		}

		// The above is running a promise, therefore we need to check if this request has stopped yet again.
		if (this._stopReading) {
			return;
		}

		if (shouldFollowRedirect) {
			// We're being redirected, we don't care about the response.
			// Keep completed uploads alive so their TCP connection can be reused. An unfinished upload is closed below.
			response.resume();

			this._cancelTimeouts?.();
			this._unproxyEvents?.();

			if (this._currentRedirectCount >= options.maxRedirects) {
				this._beforeError(new MaxRedirectsError(this));
				return;
			}

			// The redirect response is drained raw and is not the response of the next hop. Detach it
			// so `_beforeError` does not buffer its open body or read its `retry-after` when
			// following the redirect fails.
			this.response = undefined;

			const previousRequest = this._request;
			this._request = undefined;
			// An unfinished upload cannot reuse its connection and must not outlive the redirect hop.
			if (previousRequest && !previousRequest.writableFinished) {
				previousRequest.destroy();
			}

			// Reset progress for the new request.
			this._downloadedSize = 0;
			this._uploadedSize = 0;

			const updatedOptions = new Options(undefined, undefined, this.options);

			try {
				// We need this in order to support UTF-8
				const redirectBuffer = Buffer.from(redirectLocation, 'binary').toString();
				const redirectUrl = new URL(redirectBuffer, url);

				// A redirect without a fragment inherits the fragment of the original URL. See https://www.rfc-editor.org/rfc/rfc9110#section-10.2.2
				if (!redirectBuffer.includes('#')) {
					const previousUrl = url!;
					redirectUrl.hash = previousUrl.hash === '' && previousUrl.href.endsWith('#') ? '#' : previousUrl.hash;
				}

				const currentUnixSocketPath = getUnixSocketPath(url!);
				const redirectUnixSocketPath = getUnixSocketPath(redirectUrl);

				if (
					(redirectUrl.protocol === 'unix:' && redirectUnixSocketPath === undefined)
					// Relative redirects on the same socket are fine, but a redirect must not switch to a different local socket.
					|| (redirectUnixSocketPath !== undefined && currentUnixSocketPath !== redirectUnixSocketPath)
				) {
					this._beforeError(new RequestError('Cannot redirect to UNIX socket', {}, this, typedResponse));
					return;
				}

				// Redirecting to a different site, clear sensitive data.
				// For UNIX sockets, different socket paths are also different origins.
				const isDifferentOrigin = redirectUrl.origin !== url!.origin
					|| currentUnixSocketPath !== redirectUnixSocketPath;

				const serverRequestedGet = statusCode === 303 && updatedOptions.method !== 'GET' && updatedOptions.method !== 'HEAD';
				// Avoid forwarding a POST body to a different origin on historical 301/302 redirects.
				const crossOriginRequestedGet = isDifferentOrigin
					&& (statusCode === 301 || statusCode === 302)
					&& updatedOptions.method === 'POST';
				const canRewrite = statusCode !== 307 && statusCode !== 308;
				const userRequestedGet = updatedOptions.methodRewriting && canRewrite && updatedOptions.method !== 'HEAD';
				const shouldDropBody = serverRequestedGet || crossOriginRequestedGet || userRequestedGet;
				if (shouldDropBody) {
					updatedOptions.method = 'GET';
					this._dropBody(updatedOptions);
				} else if (
					isDifferentOrigin
					&& canRewrite
					&& updatedOptions.method !== 'QUERY'
					&& this._hasBodyForRedirect(updatedOptions)
				) {
					this._dropBody(updatedOptions);
				}

				if (isDifferentOrigin) {
					// On cross-origin redirects, strip sensitive headers and any credentials
					// embedded in the redirect URL itself to prevent a malicious server from
					// leaking them to a third party. 307/308 redirects preserve the method and replayable body per RFC; QUERY does the same on 301/302.
					updatedOptions.h2session = undefined;
					this._stripCrossOriginState(updatedOptions, redirectUrl);
				} else {
					redirectUrl.username = updatedOptions.username;
					redirectUrl.password = updatedOptions.password;
				}

				// Redirect URLs are resolved internally. Restore the user option before hooks run so hook mutations still honor it.
				const {allowAbsoluteUrls} = updatedOptions;
				try {
					updatedOptions.allowAbsoluteUrls = true;
					updatedOptions.url = redirectUrl;
				} finally {
					updatedOptions.allowAbsoluteUrls = allowAbsoluteUrls;
				}

				this.redirectUrls.push(redirectUrl);

				const boundaryBeforeRedirectHooks = getUrlPrefixBoundary(updatedOptions);
				const bodyBeforeRedirectHooks = updatedOptions.body;
				const h2sessionBeforeRedirectHooks = updatedOptions.h2session;
				const preHookState = isDifferentOrigin || updatedOptions.hooks.beforeRedirect.length === 0
					? undefined
					: {
						...snapshotCrossOriginState(updatedOptions),
						url: new URL(updatedOptions.url),
					};

				this._checkRequestTimeout();

				if (this._stopReading) {
					return;
				}

				const changedState = await updatedOptions.trackStateMutations(async changedState => {
					for (const hook of updatedOptions.hooks.beforeRedirect) {
						// eslint-disable-next-line no-await-in-loop
						await hook(updatedOptions, typedResponse);
						this._checkRequestTimeout(updatedOptions);

						if (this._stopReading) {
							break;
						}
					}

					return changedState;
				});

				if (this._stopReading) {
					return;
				}

				if (hasUrlOrPrefixUrlBoundaryChanged(updatedOptions, updatedOptions.url, boundaryBeforeRedirectHooks)) {
					assertUrlHasSameOriginAsPrefixUrlIfNeeded(updatedOptions, updatedOptions.url);
				}

				updatedOptions.clearUnchangedCookieHeader(preHookState, changedState);

				// If a beforeRedirect hook changed the URL to a different origin,
				// strip sensitive headers that were preserved for the original origin.
				// When isDifferentOrigin was already true, headers were already stripped above.
				if (preHookState) {
					const state = preHookState;
					const hookUrl = updatedOptions.url;
					const hookChangedOrigin = !isSameOrigin(state.url, hookUrl);

					if (
						hookChangedOrigin
						&& (statusCode === 301 || statusCode === 302)
						&& updatedOptions.method === 'POST'
					) {
						updatedOptions.method = 'GET';
						this._dropBody(updatedOptions);
					}

					if (hookChangedOrigin) {
						if (updatedOptions.h2session === h2sessionBeforeRedirectHooks) {
							updatedOptions.h2session = undefined;
						}

						if (
							canRewrite
							&& updatedOptions.method !== 'QUERY'
							&& this._hasUnchangedBodyForRedirect(updatedOptions, state, changedState)
						) {
							this._dropBody(updatedOptions);
						}

						updatedOptions.stripUnchangedCrossOriginState(state, changedState, {clearBody: false});
					}
				}

				const nativeFormDataBody = this._nativeFormDataBody;
				const bodyUnchangedByHooks = updatedOptions.body === bodyBeforeRedirectHooks;
				const wasNonReplayable = isNonReplayableBody(bodyBeforeRedirectHooks);
				const bodyWasRemovedByHooks = changedState.options.has('body')
					&& !hasBodyOption(updatedOptions)
					&& this.options.body === bodyBeforeRedirectHooks
					&& (!bodyUnchangedByHooks || this._hasWrittenBody || this._hasWritableBody);

				if (bodyWasRemovedByHooks) {
					this._dropBody(updatedOptions);
				} else if (
					!bodyUnchangedByHooks
					&& wasNonReplayable
					&& this.options.body === bodyBeforeRedirectHooks
				) {
					// A hook replaced or removed the body, so dispose of the original non-replayable one.
					this._destroyBody(bodyBeforeRedirectHooks);
				}

				// Any redirect that keeps the body must replay it, including same-origin 301/302 redirects that keep the method.
				if (this._hasBodyForRedirect(updatedOptions)) {
					if (
						bodyUnchangedByHooks
						&& nativeFormDataBody !== undefined
						&& updatedOptions.body === nativeFormDataBody.body
					) {
						this._reserializeFormDataBody(updatedOptions, changedState.headers.has('content-type'));
					} else if (
						bodyUnchangedByHooks
						&& (wasNonReplayable || (is.undefined(updatedOptions.body) && (this._hasWrittenBody || this._hasWritableBody)))
					) {
						// Body-preserving redirects must replay the body, so follow the HTTP spec and other clients by failing for unchanged non-replayable bodies. Hooks may supply a fresh body.
						this._dropBody(updatedOptions);
						this._beforeError(new RequestError('Cannot follow redirect with a non-replayable body', {}, this, typedResponse));
						return;
					}
				}

				// Hook-replaced bodies must update the inherited Content-Length unless the hook set one explicitly.
				if (!bodyUnchangedByHooks && !changedState.headers.has('content-length') && !is.undefined(updatedOptions.body)) {
					this._serializeFormDataBody(updatedOptions, changedState.headers.has('content-type'));
					this._refreshBodySize(updatedOptions);
				}

				this._assertMethodCanHaveBody(updatedOptions, changedState);

				// Publish redirect event
				const targetUrl = updatedOptions.url;
				publishRedirect(() => ({
					requestId: this._requestId,
					fromUrl: stripUrlAuth(url!),
					toUrl: stripUrlAuth(targetUrl),
					statusCode,
				}));

				this.emit('redirect', updatedOptions, typedResponse);

				if (this._stopReading) {
					return;
				}

				this.options = updatedOptions;

				await this._makeRequest();
			} catch (error: unknown) {
				// The redirect response was detached, so keep its status and headers on the error.
				this._beforeError(error instanceof RequestError || error instanceof TimedOutTimeoutError ? error : toRequestError(error, this, typedResponse));
				return;
			} finally {
				// Until these options are adopted, this scope owns any replacement body that the current request does not share.
				if (this.options !== updatedOptions && updatedOptions.body !== this.options.body) {
					this._destroyBody(updatedOptions.body);
				}
			}

			return;
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
		if (!hasNoBody && (!wasDecompressed || options.strictContentLength)) {
			const expectedLength = parseContentLength(nativeResponse.headers['content-length']);
			if (expectedLength !== undefined && expectedLength >= 0) {
				this._expectedContentLength = expectedLength;
			}
		}

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
			const captureFromResponse = response.readableEnded || responseRawBodyPromise !== undefined;
			if (!captureFromResponse) {
				canFinalizeResponse = true;
				handleResponseEnd();
			}

			const success = responseRawBodyPromise
				? await responseRawBodyPromise
				: await this._setRawBody(captureFromResponse ? response : this);

			if (captureFromResponse) {
				canFinalizeResponse = true;
				handleResponseEnd();
			}

			if (success) {
				this.emit('response', response);
			}

			return;
		}

		this.emit('response', response);

		// Synchronous listeners can edit headers or add destinations first. Keep the same preparation available when a caller awaits the event before piping.
		this._preparePipedServerResponse = destination => {
			if (destination.headersSent) {
				return;
			}

			const connectionListedHeaders = getConnectionListedHeaders(response.headers);

			for (const key in response.headers) {
				if (!Object.hasOwn(response.headers, key)) {
					continue;
				}

				// When decompression occurred, skip content-encoding and content-length
				// as they refer to the compressed data, not the decompressed stream.
				// Hop-by-hop headers apply to the upstream connection only, so an intermediary must
				// not forward them either.
				// The guards stay apart: the one above filters to own properties, this one decides
				// which of them may be forwarded.
				// eslint-disable-next-line unicorn/prefer-combined-guards
				if ((wasDecompressed && (key === 'content-encoding' || key === 'content-length')) || hopByHopHeaders.has(key) || connectionListedHeaders.has(key)) {
					continue;
				}

				const value = response.headers[key];

				// Skip if value is undefined
				if (value !== undefined) {
					destination.setHeader(key, value);
				}
			}

			destination.statusCode = statusCode;
		};

		for (const destination of this._pipedServerResponses) {
			this._preparePipedServerResponse(destination);
		}

		if (this._triggerRead) {
			this._read();
		}

		canFinalizeResponse = true;
		handleResponseEnd();
	}

	private async _setRawBody(from: Readable = this): Promise<boolean> {
		try {
			// Errors are emitted via the `error` event
			const fromArray = await from.toArray();
			const hasNonStringChunk = fromArray.some(chunk => typeof chunk !== 'string');
			const rawBody = hasNonStringChunk
				? concatUint8Arrays((fromArray as Array<string | Uint8Array>).map(chunk => typeof chunk === 'string' ? Buffer.from(chunk, from.readableEncoding ?? undefined) : chunk))
				: new Uint8Array(Buffer.from((fromArray as string[]).join(''), from.readableEncoding ?? undefined));
			const shouldUseIncrementalDecodedBody = from === this && this._incrementalDecode !== undefined;

			// On retry Request is destroyed with no error, therefore the above will successfully resolve.
			// So in order to check if this was really successful, we need to check if it has been properly ended.
			if (!this.isAborted && this.response) {
				this.response.rawBody = rawBody;
				if (from !== this) {
					this._downloadedSize = rawBody.byteLength;
				}

				if (shouldUseIncrementalDecodedBody) {
					try {
						const {decoder, chunks} = this._incrementalDecode!;
						const finalDecodedChunk = decoder.decode();
						if (finalDecodedChunk.length > 0) {
							chunks.push(finalDecodedChunk);
						}

						cacheDecodedBody(this.response, chunks.join(''));
					} catch {}
				}

				return true;
			}
		} catch {} finally {
			this._incrementalDecode = undefined;
		}

		return false;
	}

	private async _onResponse(response: IncomingMessageWithTimings): Promise<void> {
		try {
			await this._onResponseBase(response);
		} catch (error: unknown) {
			/* istanbul ignore next: better safe than sorry */
			this._beforeError(error);
		}
	}

	private _onRequest(request: ClientRequest, useCache: boolean): void {
		const {options} = this;
		const {timeout, url} = options;

		// Publish request start event. A subscriber gets a copy, so it cannot change the request.
		publishRequestStart(() => ({
			requestId: this._requestId,
			url: getSanitizedUrl(this.options),
			method: options.method,
			headers: cloneHeaders(options.headers),
		}));

		timer(request);

		// `timeout.socket` is the inactivity timeout. The HTTP/2 request maps it onto the
		// stream, so a stalled response body still times out.
		const {read: _readTimeout, ...requestTimeouts} = timeout;
		this._cancelTimeouts = timedOut(request, requestTimeouts, url!);

		let lastRequestError: Error | undefined;
		const responseEventName = useCache ? 'cacheableResponse' : 'response';

		request.once(responseEventName, (response: IncomingMessageWithTimings) => {
			void this._onResponse(response);
		});

		const emitRequestError = (error: Error): void => {
			this._aborted = true;

			// Force clean-up, because some packages (e.g. nock) don't do this.
			request.destroy();

			const wrappedError = error instanceof TimedOutTimeoutError ? this._createTimeoutError(error) : new RequestError(error.message, error, this);
			this._beforeError(wrappedError);
		};

		request.once('error', (error: Error) => {
			lastRequestError = error;

			// Ignore errors from requests superseded by a redirect.
			if (this._request !== request) {
				return;
			}

			/*
			Transient write errors (EPIPE, ECONNRESET) often fire during redirects when the
			server closes the connection after sending the redirect response. Defer by one
			microtask to let the response event make the request stale.
			*/
			if (isTransientWriteError(error)) {
				queueMicrotask(() => {
					/*
					`request.writableEnded` and `request.destroyed` are not checked here: a
					request whose body finished writing still fails when the connection resets
					before the response, so a response-less reset is the real failure and not a
					superseded request. A response that already arrived makes it stale.
					*/
					if (this._request !== request || hasResponse(request)) {
						return;
					}

					emitRequestError(error);
				});

				return;
			}

			emitRequestError(error);
		});

		if (!useCache) {
			request.once('close', () => {
				if (this._request !== request || hasResponse(request) || this._stopReading) {
					return;
				}

				this._beforeError(lastRequestError ?? createServerAbortedError(this));
			});
		}

		this._unproxyEvents = proxyEvents(request, this, proxiedRequestEvents);
		this._request = request;

		this._bodySize = parseContentLength(options.headers['content-length']);
		this.emit('uploadProgress', this.uploadProgress);

		this._sendBody();

		this.emit('request', request);
	}

	private _isRequestStale(request: ClientRequest): boolean {
		return this._request !== request || request.destroyed || request.writableEnded;
	}

	private _cancelBodySource(source: BodySource): void {
		// Clear the owned resource before cleanup so cancellation and iterator closing cannot release it twice.
		if ('reader' in source) {
			const {reader} = source;
			source.reader = undefined;
			if (reader === undefined) {
				return;
			}

			try {
				void reader.cancel().catch(noop);
			} catch {} finally {
				reader.releaseLock();
			}

			return;
		}

		const {iterator} = source;
		source.iterator = undefined;
		// Cleanup must not await an iterator whose next() is still pending.
		try {
			const returnMethod = iterator?.return;
			if (typeof returnMethod === 'function') {
				void Promise.resolve(Reflect.apply(returnMethod, iterator, [])).catch(noop);
			}
		} catch {}
	}

	private async * _iterateWebBody(body: ReadableStream) {
		const reader = body.getReader();
		const source = {body, reader};
		this._bodySource = source;

		try {
			while (true) {
				// eslint-disable-next-line no-await-in-loop
				const {done, value} = await reader.read();
				if (done) {
					return;
				}

				yield value;
			}
		} finally {
			this._cancelBodySource(source);
		}
	}

	private async * _iterateBody(body: Iterable<unknown> | AsyncIterable<unknown>) {
		let source: IterableBodySource | undefined;
		// Keep source errors separate from socket write failures, which may be retried.
		try {
			// Iteration now owns source errors, including native Readable error events.
			this._attachBodyErrorListener(undefined);
			if (body instanceof ReadableStream) {
				yield * this._iterateWebBody(body);
				return;
			}

			const asyncIterator = (body as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] ?? undefined;
			const iterator = asyncIterator === undefined ? (body as Iterable<unknown>)[Symbol.iterator]() : asyncIterator.call(body);
			const iteratorSource: IterableBodySource = {body, iterator};
			source = iteratorSource;
			this._bodySource = iteratorSource;
			if (this._stopReading) {
				return;
			}

			const ownedIterator = {
				next: iterator.next.bind(iterator),
				return: (value?: unknown) => {
					this._cancelBodySource(iteratorSource);
					const result = {done: true as const, value};
					return asyncIterator === undefined ? result : Promise.resolve(result);
				},
			};
			// Keep sync and async delegation distinct: only sync iterables await yielded promises.
			yield * asyncIterator === undefined
				? {[Symbol.iterator]: () => ownedIterator as Iterator<unknown>}
				: {[Symbol.asyncIterator]: () => ownedIterator as AsyncIterator<unknown>};
			if (!Object.is(iterator, body)) {
				// A completed factory iterator is released; a self-iterating body still belongs to request teardown.
				iteratorSource.iterator = undefined;
			}
		} catch (error) {
			throw new UploadError(error, this);
		} finally {
			if (source) {
				this._cancelBodySource(source);
			}
		}
	}

	private async _asyncWrite(chunk: any, request: ClientRequest | undefined): Promise<void> {
		return new Promise((resolve, reject) => {
			const callback = (error?: Error | null): void => { // eslint-disable-line @typescript-eslint/no-restricted-types
				if (error) {
					reject(error);
					return;
				}

				resolve();
			};

			this._writeRequest(chunk, undefined, callback, request);
		});
	}

	private _sendBody() {
		if (this._stopReading) {
			return;
		}

		if (this._bodySource) {
			this._cancelBodySource(this._bodySource);
			this._bodySource = undefined;
		}

		// Send body
		const {body} = this.options;

		// Configured bodies write directly to the native request, so public writes stay read-only.
		this._dispatchedBody = {body};
		this._attachBodyErrorListener(body);

		const currentRequest = this._currentRedirectCount === 0 && !this._discardBodyWrites ? this : this._request ?? this;

		if (is.nodeStream(body) && currentRequest === this) {
			// Hooks and handlers can replace the body after the constructor registered its listener. Preserve the pipe notification for the accepted source.
			this.emit('pipe', body);
		}

		if (this._stopReading) {
			return;
		}

		if (!this._request && body !== undefined) {
			// A direct response has no upload destination. Release the configured source without opening it, just as buffered bodies are skipped.
			this._destroyBody(body);
			if (isIterableBody(body)) {
				// Keep the released source with this request so later teardown cannot close its iterator twice.
				this._bodySource = {body, iterator: undefined};
			}

			super.end();
			return;
		}

		if (is.buffer(body)) {
			// Buffer should be sent directly without conversion
			this._writeBodyInChunks(body, currentRequest);
		} else if (ArrayBuffer.isView(body)) {
			// ArrayBuffer views should be treated like buffers, not iterated over
			// Create a Uint8Array view over the data (Node.js streams accept Uint8Array)
			const uint8View = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
			this._writeBodyInChunks(uint8View, currentRequest);
		} else if (isIterableBody(body)) {
			(async () => {
				const isInitialRequest = currentRequest === this;
				const request = isInitialRequest ? this._request : currentRequest as ClientRequest;
				const bodyOptions = this.options;
				const isBodyInactive = () => this._stopReading || this._request !== request || this.options !== bodyOptions || this.options.body !== body;

				try {
					for await (const chunk of this._iterateBody(body)) {
						if (isBodyInactive()) {
							return;
						}

						await this._asyncWrite(chunk, request);

						if (isBodyInactive()) {
							return;
						}
					}

					if (!isBodyInactive()) {
						if (isInitialRequest) {
							super.end();
							return;
						}

						await this._endWritableRequest(currentRequest as ClientRequest);
					}
				} catch (error: unknown) {
					if (isBodyInactive()) {
						return;
					}

					this._beforeError(error);
				}
			})();
		} else if (is.undefined(body)) {
			// No body to send, end the request
			if (currentRequest !== this) {
				void (async () => {
					try {
						await this._endWritableRequest(currentRequest as ClientRequest);
					} catch (error: unknown) {
						this._beforeError(error);
					}
				})();
			} else if ((this._noPipe ?? false) || !this._methodCanHaveBody) {
				currentRequest.end();
			}
		} else {
			// Handles string bodies (from json/form options).
			this._writeBodyInChunks(stringToUint8Array(body), currentRequest);
		}
	}

	/*
	Write a body buffer in chunks to enable granular `uploadProgress` events.

	Without chunking, string/Uint8Array/TypedArray bodies are written in a single call, causing `uploadProgress` to only emit 0% and 100% with nothing in between.

	The 64 KB chunk size matches Node.js fs stream defaults.
	*/
	private _writeBodyInChunks(buffer: Uint8Array, currentRequest: Request | ClientRequest) {
		const isInitialRequest = currentRequest === this;

		(async () => {
			const request = isInitialRequest ? this._request : currentRequest as ClientRequest;

			try {
				if (!request) {
					if (isInitialRequest) {
						super.end();
					}

					return;
				}

				if (request.destroyed) {
					return;
				}

				await this._writeChunksToRequest(buffer, request);

				// Failure handling still owns teardown while error hooks or response capture are pending.
				if (this._stopReading) {
					return;
				}

				if (this._isRequestStale(request)) {
					this._finalizeStaleChunkedWrite(request, isInitialRequest);
					return;
				}

				if (isInitialRequest) {
					super.end();
					return;
				}

				await this._endWritableRequest(request);
			} catch (error: unknown) {
				const normalizedError = normalizeError(error);

				// Transient write errors (EPIPE, ECONNRESET) are handled by the request-level
				// error and close handlers. For initial redirected writes, still finalize
				// writable state once the stale transition becomes observable.
				if (isTransientWriteError(normalizedError)) {
					if (isInitialRequest && request) {
						const initialRequest = request;
						let didFinalize = false;
						const finalizeIfStale = () => {
							if (didFinalize || !this._isRequestStale(initialRequest)) {
								return;
							}

							didFinalize = true;
							this._finalizeStaleChunkedWrite(initialRequest, true);
						};

						finalizeIfStale();

						if (!didFinalize) {
							initialRequest.once('response', finalizeIfStale);
							queueMicrotask(finalizeIfStale);
						}
					}

					return;
				}

				if (!isInitialRequest && this._isRequestStale(currentRequest as ClientRequest)) {
					return;
				}

				this._beforeError(error);
			}
		})();
	}

	private _finalizeStaleChunkedWrite(request: ClientRequest, isInitialRequest: boolean) {
		if (!request.destroyed && !request.writableEnded) {
			request.destroy();
		}

		if (isInitialRequest) {
			// Finalize writable state without ending the active redirected request.
			this._skipRequestEndInFinal = true;
			super.end();
		}
	}

	private _emitProgress(eventName: 'uploadProgress' | 'downloadProgress', progress: Progress): void {
		if (this._stopReading) {
			return;
		}

		// Native callbacks must still settle their write or end operation when an observer throws.
		try {
			this.emit(eventName, progress);
		} catch (error: unknown) {
			this._beforeError(error);
		}
	}

	private _emitUploadComplete(request: ClientRequest) {
		if (this._request !== request || request.destroyed) {
			return;
		}

		this._bodySize = this._uploadedSize;
		this._emitProgress('uploadProgress', this.uploadProgress);
		if (this._stopReading) {
			return;
		}

		request.emit('upload-complete');
	}

	private async _endWritableRequest(request: ClientRequest): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			request.end((error?: Error | null) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				if (error) {
					reject(error);
					return;
				}

				this._emitUploadComplete(request);

				resolve();
			});
		});
	}

	private _stripCrossOriginState(options: Options, urlToClear: URL) {
		for (const header of crossOriginStripHeaders) {
			options.deleteInternalHeader(header);
		}

		options.username = '';
		options.password = '';

		urlToClear.username = '';
		urlToClear.password = '';
	}

	private get _methodCanHaveBody(): boolean {
		return methodCanHaveBody(this.options);
	}

	private get _currentRedirectCount(): number {
		return this.redirectUrls.length - this._previousRedirectCount;
	}

	private _canWriteBody(): boolean {
		return !this._noPipe && !this.isReadonly && this._methodCanHaveBody;
	}

	private _hasBodyForRedirect(options: Options): boolean {
		return hasBodyOption(options) || this._hasWrittenBody || this._hasWritableBody;
	}

	private _hasUnchangedBodyForRedirect(options: Options, state: CrossOriginState, changedState: StateMutations): boolean {
		return !hasBodyOptionChanged(changedState)
			&& this._hasBodyForRedirect(options)
			&& isBodyUnchanged(options, state);
	}

	// A hook that switched to a method that cannot carry a body must drop or replace the body,
	// the same way the initial request preparation requires.
	private _assertMethodCanHaveBody(options: Options, changedState: StateMutations): void {
		if (changedState.options.has('method') && !is.undefined(options.body) && !methodCanHaveBody(options)) {
			throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
		}
	}

	private _refreshBodySize(options: Options): void {
		const bodySize = is.undefined(options.body) || !is.undefined(options.getInternalHeaders()['transfer-encoding']) ? undefined : getBodySize(options.body, undefined);
		if (bodySize === undefined) {
			options.deleteInternalHeader('content-length');
		} else {
			options.setInternalHeader('content-length', String(bodySize));
		}

		this._bodySize = bodySize;
	}

	private _dropBody(updatedOptions: Options) {
		// Dropping this upload also discards its queued public writes.
		this._discardBodyWrites = true;
		const {body} = this.options;
		const updatedBody = updatedOptions.body;
		const hadOptionBody = hasBodyOption(this.options);

		this.options.clearBody();

		this._destroyBody(body);
		if (updatedBody !== body) {
			this._destroyBody(updatedBody);
		}

		if (!hadOptionBody && !this.writableEnded) {
			this._skipRequestEndInFinal = true;
			super.end();
		}

		updatedOptions.clearBody();

		this._bodySize = undefined;
		this._hasWrittenBody = false;
		this._hasWritableBody = false;
	}

	private _reserializeFormDataBody(options: Options, contentTypeChanged: boolean): void {
		const nativeFormDataBody = this._nativeFormDataBody!;

		// Native FormData generates a fresh stream and boundary, so re-serialize it to replay the upload.
		this._destroyBody(options.body);
		const {body, contentType} = serializeNativeFormDataBody(nativeFormDataBody.form);

		nativeFormDataBody.body = body;
		options.body = body;

		if (contentTypeChanged) {
			nativeFormDataBody.contentTypeWasGenerated = false;
		} else if (nativeFormDataBody.contentTypeWasGenerated) {
			options.setGeneratedHeader('content-type', contentType);
		}
	}

	private _destroyBody(body: unknown) {
		const source = this._bodySource?.body === body ? this._bodySource : undefined;
		if (is.nodeStream(body)) {
			const bodyStream = body as NodeJS.ReadableStream & {destroy(): void};
			bodyStream.off('error', this._onBodyError);
			bodyStream.unpipe();
			bodyStream.on('error', noop);
			if (source) {
				this._cancelBodySource(source);
			}

			bodyStream.destroy();
		} else if (source) {
			this._cancelBodySource(source);
		} else if (body instanceof ReadableStream) {
			if (!body.locked) {
				void body.cancel().catch(noop);
			}
		} else if (isIterableBody(body)) {
			// Signal the iterator to clean up, but don't await it:
			// the for-await loop in _sendBody exits via the options.body sentinel,
			// and awaiting return() would deadlock when next() is pending.
			this._cancelBodySource({body, iterator: body as unknown as Iterator<unknown> | AsyncIterator<unknown>});
		}
	}

	/**
	Transfers the source-error subscription without destroying the previous body.
	*/
	private _attachBodyErrorListener(body: unknown): void {
		this._bodyErrorStream?.off('error', this._onBodyError);
		this._bodyErrorStream = is.nodeStream(body) ? body : undefined;
		this._bodyErrorStream?.once('error', this._onBodyError);
	}

	private readonly _onBodyError = (error: Error): void => {
		const ownedBody = this._dispatchedBody === undefined ? this.options.body : this._dispatchedBody.body;
		if (this._bodyErrorStream !== ownedBody) {
			return;
		}

		if (this._flushed) {
			this._beforeError(new UploadError(error, this));
		} else {
			this.flush = async () => {
				this.flush = async () => {};

				this._beforeError(new UploadError(error, this));
			};
		}
	};

	private async _writeChunksToRequest(buffer: Uint8Array, request: ClientRequest): Promise<void> {
		const chunkSize = 65_536; // 64 KB
		const isInactive = () => this._stopReading || this._isRequestStale(request);

		for (const part of chunk(buffer, chunkSize)) {
			if (isInactive()) {
				return;
			}

			// eslint-disable-next-line no-await-in-loop
			await new Promise<void>((resolve, reject) => {
				this._writeRequest(part, undefined, error => {
					if (isInactive()) {
						resolve();
						return;
					}

					if (error) {
						reject(error);
					} else {
						setImmediate(resolve);
					}
				}, request);
			});
		}
	}

	private _prepareCache(cache: string | StorageAdapter) {
		if (cacheableStore.has(cache)) {
			return;
		}

		const cacheableRequest = new CacheableRequest(
			((requestOptions: RequestOptions, handler?: (response: IncomingMessageWithTimings) => void): ClientRequest => {
				const gotRequest = (requestOptions as any).gotRequest as Request | undefined;
				if (gotRequest?._stopReading) {
					throw new AbortError(gotRequest);
				}

				/**
				Wraps the cacheable-request handler to run beforeCache hooks.
				These hooks control caching behavior by:
				- Directly mutating the response object (changes apply to what gets cached)
				- Returning `false` to prevent caching
				- Returning `void`/`undefined` to use default caching behavior

				Hooks use direct mutation - they can modify response.headers, response.statusCode, etc.
				Mutations take effect immediately and determine what gets cached.
				*/
				const wrappedHandler = handler
					? (response: IncomingMessageWithTimings) => {
						const {beforeCacheHooks, gotRequest} = requestOptions as any;

						// Early return if no hooks - cache the original response
						if (!beforeCacheHooks || beforeCacheHooks.length === 0) {
							handler(response);
							return;
						}

						// The hooks change the caching layer's view of the headers, not the response the
						// caller receives. The cache policy keeps a reference to whatever `headers` holds
						// when it is built, so a copy is swapped in and swapped back afterwards. The copy
						// must own the array values too, or a hook pushing to `set-cookie` would edit the
						// caller's list. Unlike headers, a status mutation is shared with the caller on
						// purpose: the live response streams carry it.
						const callerHeaders = response.headers;
						response.headers = cloneHeaders(callerHeaders);

						try {
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
										// Observe the rejected return value so only the hook contract error escapes.
										void Promise.resolve(result).catch(noop);
										throw new TypeError('beforeCache hooks must be synchronous. The hook returned a Promise, but this hook must return synchronously. If you need async logic, use beforeRequest hook instead.');
									}

									if (result !== undefined) {
										// Hooks should return false or undefined only
										// Mutations work directly - no need to return the response
										throw new TypeError('beforeCache hook must return false or undefined. To modify the response, mutate it directly.');
									}
									// Else: void/undefined = continue
								}
							} catch (error: unknown) {
								// Convert hook errors to RequestError and propagate
								// This is consistent with how other hooks handle errors
								if (gotRequest) {
									gotRequest._beforeError(error);
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
						} finally {
							// The caller's response keeps the server's headers, whatever the hooks or
							// the cache layer did with the copy.
							response.headers = callerHeaders;
						}
					}
					: handler;

				const result = (requestOptions as any)._request(requestOptions, wrappedHandler);

				// TODO: remove this when `cacheable-request` supports async request functions.
				if (is.promise(result)) {
					// We only need to implement the error handler in order to support HTTP/2 caching.
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
							throw new Error(`Unknown HTTP/2 promise event: ${event}`);
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
			const hostname = is.string(url.hostname) && url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
			const nativeRequest = (options as any)._request as typeof http.request;
			const requestTarget = {path: options.path ?? `${url.pathname}${url.search}`, pathname: url.pathname, search: url.search};
			// Encode the exact physical URI as one value so cache URL normalization cannot change its meaning.
			const cacheSearch = `?target=${encodeURIComponent(`${url.origin}${url.pathname}${url.search}`)}`;
			// Restore native URL fields after cache-key construction, retaining revalidation headers.
			(options as any)._request = (requestOptions: RequestOptions, callback?: (response: IncomingMessageWithTimings) => void) => {
				Object.assign(requestOptions, requestTarget);
				// Own the options actually passed to the transport, including its in-flight ALPN socket.
				this._requestOptions = requestOptions;
				return nativeRequest(url, requestOptions, callback);
			};

			Object.assign(options, {
				protocol: url.protocol,
				hostname,
				host: hostname,
				hash: url.hash === '' ? '' : (url.hash ?? null),
				search: cacheSearch,
				pathname: '/cache',
				href: url.href,
				path: `/cache${cacheSearch}`,
				...(is.string(url.port) && url.port.length > 0 && {port: Number(url.port)}),
				// The `&&` form spreads an empty credential as `{0: ''}`, so the absent case stays
				// explicit. A URL such as `http://@example.com` has both parts set to `''`.
				// eslint-disable-next-line unicorn/consistent-conditional-object-spread
				...(url.username || url.password ? {auth: `${url.username || ''}:${url.password || ''}`} : {}),
			});

			let request: ClientRequest | Promise<ClientRequest>;

			// TODO: Fix `cacheable-response`. This is ugly.
			const cacheRequest = cacheableStore.get((options as any).cache)!(options as CacheableOptions, (response: any) => {
				void (async () => {
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
				})().catch((error: unknown) => {
					// An asynchronous transport can reject after its response callback ran. This scope owns that unread response until the transport is adopted.
					// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the transport's rejection reason.
					reject(error);
					destroyRequestResult(response);
					destroyRequestResult(response.req);
				});
			});

			cacheRequest.once('error', (error: Error) => {
				reject(error);
				// Cache storage can fail after the native request has resolved this setup promise.
				// Promise response hooks can still be active after EOF; a stream finishes when both sides finish.
				if (this._noPipe === true || !this.readableEnded || !this.writableFinished) {
					this._beforeError(error instanceof CacheableCacheError ? new CacheError(error, this) : error);
				}
			});
			cacheRequest.once('request', (requestOrPromise: ClientRequest | Promise<ClientRequest>) => {
				request = requestOrPromise;
				resolve(request);
			});
		});
	}

	// `timeout.request` is a global budget: one timer covers the whole request, including redirects and the hooks between them.
	// Redirect and hook boundaries call this again so time spent in hooks counts and changes hooks make to `timeout.request` take effect.
	// The budget is read from the options the hook mutated, which is not `this.options` until the hooks are done.
	private _checkRequestTimeout(options: Options = this.options): void {
		clearTimeout(this._requestTimeout);

		const budget = options.timeout.request;
		if (budget === undefined || this._startedAt === undefined || this._stopReading) {
			return;
		}

		const remaining = budget - (Date.now() - this._startedAt);
		if (remaining <= 0) {
			this._expireTimeout(new TimedOutTimeoutError(budget, 'request'));
			return;
		}

		// Node turns overflowing timer delays into 1 ms, so an unarmable budget means no timeout.
		if (!isArmableTimerDelay(remaining)) {
			return;
		}

		this._requestTimeout = setTimeout(() => {
			// A hook may have changed the budget while the timer was pending, so only an unchanged budget expires here.
			if (options.timeout.request === budget) {
				this._expireTimeout(new TimedOutTimeoutError(budget, 'request'));
			} else {
				this._checkRequestTimeout(options);
			}
		}, remaining);
		this._requestTimeout.unref();
	}

	private _expireTimeout(error: TimedOutTimeoutError): void {
		// An in-flight native request reports the error through its own error handler, which tears down the socket and records the timings.
		if (this._request && !this._request.destroyed) {
			this._request.destroy(error);
		} else {
			this._beforeError(error);
			// Claim the timeout before closing a custom response that can emit `aborted` during destruction.
			destroyRequestResult(this.response);
		}
	}

	private async _makeRequest(): Promise<void> {
		const {options} = this;
		this._attachAbortListener();

		if (this._currentRedirectCount > 0) {
			this._checkRequestTimeout();
		}

		if (this.destroyed || this._stopReading) {
			return;
		}

		const shouldDeleteGeneratedHeader = (currentHeader: string | string[] | undefined, generatedHeader: string | undefined) => currentHeader === generatedHeader || is.undefined(currentHeader);
		const syncGeneratedHeader = (name: 'authorization' | 'cookie', {
			currentHeader,
			explicitHeader,
			nextHeader,
			staleGeneratedHeader,
		}: {
			currentHeader: string | string[] | undefined;
			explicitHeader: string | string[] | undefined;
			nextHeader: string | undefined;
			staleGeneratedHeader: string | undefined;
		}) => {
			if (!is.undefined(nextHeader)) {
				options.setInternalHeader(name, nextHeader);
			} else if (!is.undefined(explicitHeader) && currentHeader === staleGeneratedHeader) {
				options.setInternalHeader(name, explicitHeader);
			} else if (shouldDeleteGeneratedHeader(currentHeader, staleGeneratedHeader)) {
				options.deleteInternalHeader(name);
			}
		};

		const getAuthorizationHeader = (username: string, password: string, isExplicitlyOmitted: boolean) => !isExplicitlyOmitted && (username || password)
			? `Basic ${stringToBase64(`${username}:${password}`)}`
			: undefined;
		const sanitizeHeaders = () => {
			const currentHeaders = options.getInternalHeaders();

			for (const key in currentHeaders) {
				if (is.undefined(currentHeaders[key])) {
					options.deleteInternalHeader(key);
				} else if (is.null(currentHeaders[key])) {
					throw new TypeError(`Use \`undefined\` instead of \`null\` to delete the \`${key}\` header`);
				} else if (Array.isArray(currentHeaders[key]) && (key === 'transfer-encoding' || singleValueRequestHeaders.has(key))) {
					// Node serializes request header arrays as repeated field lines, so keep framing
					// unambiguous, and duplicate credential and content-length lines are not allowed on
					// requests. Normalize a single-element array to match the long-supported string path.
					if (currentHeaders[key].length !== 1) {
						throw new TypeError(`The \`${key}\` header must be a single value`);
					}

					options.setInternalHeader(key, currentHeaders[key][0]);
				}
			}

			return currentHeaders;
		};

		const getCookieHeader = async (cookieJar: PromiseCookieJar | undefined) => {
			if (!cookieJar) {
				return undefined;
			}

			const cookieString = await cookieJar.getCookieString(options.url!.toString());
			return is.nonEmptyString(cookieString) ? cookieString : undefined;
		};

		if (options.cookieJar && !options.isHeaderExplicitlySet('cookie')) {
			options.deleteInternalHeader('cookie');
		}

		const headers = sanitizeHeaders();
		const initialHeaders = options.getInternalHeaders();
		const authorizationWasInitiallyExplicit = options.isHeaderExplicitlySet('authorization');
		const explicitAuthorizationHeader = authorizationWasInitiallyExplicit ? initialHeaders.authorization : undefined;
		const explicitCookieHeader = options.isHeaderExplicitlySet('cookie') ? initialHeaders.cookie : undefined;
		const authorizationWasInitiallyOmitted = authorizationWasInitiallyExplicit && is.undefined(initialHeaders.authorization);
		const cookieWasInitiallyOmitted = options.isHeaderExplicitlySet('cookie') && is.undefined(initialHeaders.cookie);

		if (options.decompress && is.undefined(headers['accept-encoding']) && !options.isHeaderExplicitlySet('accept-encoding')) {
			const encodings = supportsBrotli ? ['gzip', 'deflate', 'br'] : ['gzip', 'deflate'];

			if (supportsZstd) {
				encodings.push('zstd');
			}

			options.setInternalHeader('accept-encoding', encodings.join(', '));
		}

		const {username, password} = options;
		const cookieJar = options.cookieJar as PromiseCookieJar | undefined;
		// Preserve an explicit Authorization header over URL-derived Basic auth. This keeps
		// normalized single-element arrays aligned with the long-supported string behavior.
		const generatedAuthorizationHeader = is.undefined(explicitAuthorizationHeader)
			? getAuthorizationHeader(username, password, authorizationWasInitiallyOmitted)
			: undefined;
		let generatedCookieHeader: string | undefined;

		if (!is.undefined(generatedAuthorizationHeader)) {
			options.setInternalHeader('authorization', generatedAuthorizationHeader);
		}

		// Only hooks need the preliminary cookie header. The final lookup below remains authoritative.
		if (!cookieWasInitiallyOmitted && options.hooks.beforeRequest.length > 0) {
			generatedCookieHeader = await getCookieHeader(cookieJar);
			this._checkRequestTimeout();

			if (this._stopReading) {
				return;
			}

			if (!is.undefined(generatedCookieHeader)) {
				options.setInternalHeader('cookie', generatedCookieHeader);
			}
		}

		let request: ReturnType<Options['getRequestFunction']> | undefined;
		const boundaryBeforeRequestHooks = getUrlPrefixBoundary(options);
		// Only request hooks need a body snapshot for detecting an unchanged cross-origin upload.
		const urlBeforeRequestHooks = options.hooks.beforeRequest.length > 0 ? boundaryBeforeRequestHooks.url : undefined;
		const stateBeforeRequestHooks = urlBeforeRequestHooks ? snapshotCrossOriginState(options) : undefined;
		const crossOriginHookStrippedHeaders = new Set<string>();
		const changedState = await options.trackStateMutations(async changedState => {
			for (const hook of options.hooks.beforeRequest) {
				// eslint-disable-next-line no-await-in-loop
				const result = await hook(options, {retryCount: this.retryCount});
				this._checkRequestTimeout();

				if (this._stopReading) {
					// The request timed out or was aborted while the hook was pending.
					destroyRequestResult(result);
					break;
				}

				if (!is.undefined(result)) {
					// @ts-expect-error Skip the type mismatch to support abstract responses
					request = () => result;
					break;
				}
			}

			return changedState;
		});

		this._attachAbortListener();

		if (this.destroyed) {
			return;
		}

		let shouldOmitRequestUrlCredentials = false;

		// A hook that replaced the body must refresh the inherited `content-length`, or the
		// declared length belongs to the previous body and the extra bytes stay on the
		// connection. The sibling retry and redirect hooks do the same, and additionally tear
		// down the body they replaced, which this path has no use for: the hook is done with
		// it and the caller still owns it.
		if (changedState.options.has('body') && !changedState.headers.has('content-length')) {
			this._serializeFormDataBody(options, changedState.headers.has('content-type'));
			this._refreshBodySize(options);
		}

		this._assertMethodCanHaveBody(options, changedState);

		if (
			urlBeforeRequestHooks
			&& options.url instanceof URL
			&& hasUrlOrPrefixUrlBoundaryChanged(options, options.url, boundaryBeforeRequestHooks)
		) {
			assertUrlHasSameOriginAsPrefixUrlIfNeeded(options, options.url);
		}

		if (
			urlBeforeRequestHooks
			&& options.url instanceof URL
			&& !isSameOrigin(urlBeforeRequestHooks, options.url)
		) {
			const currentHeaders = options.getInternalHeaders();
			const changedHeaders: Record<string, string | string[] | undefined> = {};

			for (const header of crossOriginStripHeaders) {
				if (!isDeepStrictEqual(currentHeaders[header], stateBeforeRequestHooks!.headers[header])) {
					changedState.headers.add(header);
				}

				if (changedState.headers.has(header)) {
					changedHeaders[header] = currentHeaders[header];
				} else {
					options.deleteInternalHeader(header);
					crossOriginHookStrippedHeaders.add(header);
				}
			}

			const changedOptions: OptionsInit = {
				headers: changedHeaders,
				...(changedState.options.has('url') && {url: options.url}),
				...(changedState.options.has('prefixUrl') && {prefixUrl: options.prefixUrl}),
				...(changedState.options.has('username') && {username: options.username}),
				...(changedState.options.has('password') && {password: options.password}),
			};

			options.stripSensitiveHeaders(urlBeforeRequestHooks, options.url, changedOptions);

			this._discardBodyWrites = true;
			this._hasWrittenBody = false;
			this._hasWritableBody = false;

			if (
				!hasBodyOptionChanged(changedState)
				&& isBodyUnchanged(options, stateBeforeRequestHooks!)
			) {
				options.clearBody();
				this._bodySize = undefined;
			}
		}

		if (request === undefined) {
			const currentHeaders = options.getInternalHeaders();
			// `headers.authorization = undefined` / `headers.cookie = undefined` is an
			// explicit opt-out. Respect that instead of regenerating values from URL
			// credentials or the cookie jar later in request setup.
			const isHeaderExplicitlyOmitted = (header: 'authorization' | 'cookie') => options.isHeaderExplicitlySet(header)
				&& (Object.hasOwn(currentHeaders, header) || changedState.headers.has(header))
				&& is.undefined(currentHeaders[header]);
			const currentAuthorizationHeader = currentHeaders.authorization;
			const currentCookieHeader = currentHeaders.cookie;
			// Authorization follows a small contract:
			// - A concrete Authorization header is sent as-is.
			// - `authorization = undefined` means omit Authorization entirely, including URL auth.
			// - Deleting an Authorization header that started explicit also means omit it.
			// - Otherwise, if the request did not start with explicit Authorization, Got may
			//   generate Basic auth from the current username/password.
			const authorizationWasExplicitlyOmitted = isHeaderExplicitlyOmitted('authorization')
				|| (
					authorizationWasInitiallyExplicit
					&& !crossOriginHookStrippedHeaders.has('authorization')
					&& is.undefined(currentAuthorizationHeader)
				);
			const cookieWasExplicitlyOmitted = is.undefined(currentCookieHeader)
				&& (cookieWasInitiallyOmitted || isHeaderExplicitlyOmitted('cookie'));

			sanitizeHeaders();

			if (!is.undefined(currentHeaders['transfer-encoding']) && !is.undefined(currentHeaders['content-length'])) {
				options.deleteInternalHeader('content-length');
			}

			if (authorizationWasExplicitlyOmitted) {
				shouldOmitRequestUrlCredentials = true;
				options.deleteInternalHeader('authorization');

				if (changedState.headers.has('authorization') && is.undefined(explicitAuthorizationHeader) && !authorizationWasInitiallyOmitted) {
					delete options.headers.authorization;
				}
			}

			const authorizationHeader = !authorizationWasInitiallyExplicit
				&& !authorizationWasInitiallyOmitted
				&& !authorizationWasExplicitlyOmitted
				? getAuthorizationHeader(options.username, options.password, authorizationWasExplicitlyOmitted)
				: undefined;
			const cookieJar = options.cookieJar as PromiseCookieJar | undefined;
			if (changedState.headers.has('authorization') && !is.undefined(currentAuthorizationHeader)) {
				// A beforeRequest hook intentionally set the outgoing Authorization header.
			} else {
				const restorableAuthorizationHeader = crossOriginHookStrippedHeaders.has('authorization') || (changedState.headers.has('authorization') && is.undefined(currentAuthorizationHeader))
					? undefined
					: explicitAuthorizationHeader;
				syncGeneratedHeader('authorization', {
					currentHeader: currentAuthorizationHeader,
					explicitHeader: restorableAuthorizationHeader,
					nextHeader: authorizationHeader,
					staleGeneratedHeader: generatedAuthorizationHeader,
				});
			}

			if (cookieWasExplicitlyOmitted) {
				options.deleteInternalHeader('cookie');

				if (changedState.headers.has('cookie') && is.undefined(explicitCookieHeader) && !cookieWasInitiallyOmitted) {
					delete options.headers.cookie;
				}
			} else if (changedState.headers.has('cookie')) {
				// A beforeRequest hook intentionally set the outgoing Cookie header.
			} else {
				const cookieHeader = !cookieWasInitiallyOmitted && !cookieWasExplicitlyOmitted
					? await getCookieHeader(cookieJar)
					: undefined;
				const restorableCookieHeader = crossOriginHookStrippedHeaders.has('cookie')
					? undefined
					: explicitCookieHeader;

				syncGeneratedHeader('cookie', {
					currentHeader: currentCookieHeader,
					explicitHeader: restorableCookieHeader,
					nextHeader: cookieHeader,
					staleGeneratedHeader: generatedCookieHeader,
				});
			}
		}

		request ??= options.getRequestFunction();

		const url = shouldOmitRequestUrlCredentials
			? new URL(stripUrlAuth(options.url!))
			: options.url!;

		this._requestOptions = options.createNativeRequestOptions() as NativeRequestOptions;

		if (shouldOmitRequestUrlCredentials) {
			this._requestOptions.auth = undefined;
		}

		// Streaming uploads cannot provide a cache key without consuming the body, and GET cache keys do not include a payload.
		const useCache = Boolean(options.cache)
			&& !this._canWriteBody()
			&& (options.method !== 'GET' || options.body === undefined)
			&& (options.body === undefined || typeof options.body === 'string' || ArrayBuffer.isView(options.body));

		if (useCache) {
			Object.assign(this._requestOptions, {
				_request: request,
				cache: options.cache,
				// Only POST responses can store a payload-dependent cache entry. Other methods must not hash an unused body key.
				body: options.method === 'POST' ? options.body : undefined,
				beforeCacheHooks: options.hooks.beforeCache,
				gotRequest: this,
			});

			try {
				this._prepareCache(options.cache as StorageAdapter);
			} catch (error: unknown) {
				throw new CacheError(error, this);
			}
		}

		// Cache support
		const function_ = useCache ? this._createCacheableRequest.bind(this) : request;

		try {
			// We can't do `await fn(...)`,
			// because stream `error` event can be emitted before `Promise.resolve()`.
			// The request budget starts once the initial setup is done and is shared by every redirect.
			this._startedAt ??= Date.now();
			this._checkRequestTimeout();

			if (this._stopReading) {
				return;
			}

			let requestOrResponse = function_!(url, this._requestOptions);

			if (is.promise(requestOrResponse)) {
				requestOrResponse = await requestOrResponse;
			}

			if (this._stopReading) {
				// The request timed out or was aborted while the request function was pending.
				destroyRequestResult(requestOrResponse);
				throw new AbortError(this);
			}

			if (isClientRequest(requestOrResponse!)) {
				this._onRequest(requestOrResponse, useCache);
			} else {
				void this._onResponse(requestOrResponse as IncomingMessageWithTimings);

				if (!this.writableEnded) {
					this._sendBody();
				}
			}
		} catch (error) {
			if (error instanceof CacheableCacheError) {
				throw new CacheError(error, this);
			}

			throw error;
		}
	}

	private async _error(error: RequestError): Promise<void> {
		// Retry rollback starts on a destroyed request and must still run its error hooks.
		// Destruction without an error only cleans up resources; `errored` identifies a failure claimed during a hook.
		const wasDestroyed = this.destroyed;

		try {
			// Skip calling hooks for HTTP errors when throwHttpErrors is false (Promise API only).
			// See https://github.com/sindresorhus/got/issues/2103
			if (this.options && (!(error instanceof HTTPError) || this.options.throwHttpErrors)) {
				const hooks = this.options.hooks.beforeError;
				for (const hook of hooks) {
					// eslint-disable-next-line no-await-in-loop
					error = await hook(error) as RequestError;
					if (!wasDestroyed && this.destroyed && this.errored) {
						return;
					}

					// Validate hook return value
					// Native errors from another realm do not inherit this realm's Error prototype.
					// eslint-disable-next-line @typescript-eslint/no-deprecated -- Error.isError is unavailable on supported Node.js 22.
					if (!(error instanceof Error) && !types.isNativeError(error)) {
						const received = error === null ? 'null' : (is.string(error) ? 'string' : (typeof error));
						throw new TypeError(`The \`beforeError\` hook must return an Error instance. Received ${received}.`);
					}
				}
			}
		} catch (error_: unknown) {
			if (!wasDestroyed && this.destroyed && this.errored) {
				return;
			}

			error = toRequestError(error_, this);
		}

		// Keep the final hook result with its request instead of sharing provenance between requests that reuse an Error object.
		this._beforeErrorResult = error;
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

	private _writeRequest(chunk: any, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void, request: ClientRequest | undefined = this._request): void { // eslint-disable-line @typescript-eslint/no-restricted-types
		if (!request || request.destroyed) {
			// When there's no request (e.g., using cached response from beforeRequest hook),
			// we still need to call the callback to allow the stream to finish properly.
			callback();
			return;
		}

		request.write(chunk, encoding as any, (error?: Error | null) => { // eslint-disable-line @typescript-eslint/no-restricted-types
			// The `!destroyed` check is required to prevent `uploadProgress` being emitted after the stream was destroyed.
			// The `this._request === request` check prevents stale write callbacks from a pre-redirect request from incrementing `_uploadedSize` after it's been reset.
			if (!error && !request.destroyed && this._request === request) {
				// For strings, count the encoded bytes without allocating a second encoded copy.
				this._uploadedSize += typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : byteLength(chunk);

				const progress = this.uploadProgress;

				if (progress.percent < 1) {
					this._emitProgress('uploadProgress', progress);
				}
			}

			// A retired native upload no longer owns the outer writable's failure.
			callback(this._request === request ? error : undefined);
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
		return makeProgress(this._downloadedSize, this._responseSize);
	}

	/**
	Progress event for uploading (sending a request).
	*/
	get uploadProgress(): Progress {
		return makeProgress(this._uploadedSize, this._bodySize);
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
		return this.response?.isFromCache;
	}

	get reusedSocket(): boolean | undefined {
		return this._request?.reusedSocket;
	}

	/**
	Whether the stream is read-only. Returns `true` when `body`, `json`, or `form` options are provided.
	*/
	get isReadonly(): boolean {
		return hasBodyOption(this.options);
	}
}
