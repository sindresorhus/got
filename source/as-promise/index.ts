import {EventEmitter} from 'node:events';
import is from '@sindresorhus/is';
import {
	normalizeError,
	HTTPError,
	RetryError,
	SchemaValidationError,
	type RequestError,
} from '../core/errors.js';
import Request from '../core/index.js';
import type {StandardSchemaV1} from '../core/standard-schema.js';
import isNonReplayableBody from '../core/utils/is-non-replayable-body.js';
import {
	decodeUint8Array,
	parseBody,
	isResponseBodyless,
	isResponseOk,
	type Response,
	ParseError,
} from '../core/response.js';
import proxyEvents from '../core/utils/proxy-events.js';
import {
	cloneRawOptions,
	getUrlPrefixBoundary,
	hasBodyOptionChanged,
	snapshotCrossOriginState,
} from '../core/options.js';
import type Options from '../core/options.js';
import {type RequestPromise} from './types.js';

const compressedEncodings = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);

const proxiedRequestEvents = [
	'request',
	'redirect',
	'uploadProgress',
	'downloadProgress',
];

/**
Copy Got's methods without copying another Promise implementation's private state.
*/
export const copyRequestMethods = (source: RequestPromise, target: Promise<unknown>): void => {
	for (const method of ['on', 'once', 'off', 'json', 'text', 'buffer'] as const) {
		if (!Reflect.has(target, method)) {
			Reflect.set(target, method, source[method]);
		}
	}
};

const validateWithSchema = async (value: unknown, schema: StandardSchemaV1): Promise<unknown> => {
	// JavaScript users can pass anything, so check the shape before calling into the schema.
	const standardSchema = is.object(schema) ? schema['~standard'] : undefined;

	if (!is.object(standardSchema) || typeof standardSchema.validate !== 'function') {
		throw new TypeError('The `schema` argument must follow the Standard Schema specification');
	}

	const validationResult = await standardSchema.validate(value);

	if (validationResult.issues) {
		throw new SchemaValidationError(validationResult.issues);
	}

	return validationResult.value;
};

export default function asPromise<T>(firstRequest?: Request): {promise: RequestPromise<T>; readonly request: Request} {
	let globalRequest: Request;
	const emitter = new EventEmitter();
	let promiseSettled = false;

	const promise = new Promise<T>((resolve, reject) => {
		const makeRequest = (retryCount: number, defaultOptions?: Options, retrySource?: Request): void => {
			const request = firstRequest ?? new Request(undefined, undefined, defaultOptions, retrySource);
			request.retryCount = retryCount;
			request._noPipe = true;

			globalRequest = request;
			const setResponse = (response: Response): void => {
				request.response = response;
				response.ok = isResponseOk(response);
			};

			// Settles the promise and emits `response`. The event carries the response the promise settles
			// with, not the response of an attempt that is about to be retried or thrown.
			const resolveWithResponse = (response: Response): void => {
				request.destroy();
				promiseSettled = true;

				// The listener runs outside any request error handling, so a throw would otherwise
				// escape as an unhandled error and leave the promise pending. The later `resolve()` is
				// then a no-op.
				try {
					emitter.emit('response', response);
				} catch (error) {
					reject(normalizeError(error));
				}

				// eslint-disable-next-line unicorn/no-multiple-promise-resolver-calls
				resolve(request.options.resolveBodyOnly ? response.body as T : response as unknown as T);
			};

			request.once('response', (response: Response) => {
				void (async () => {
				// Parse body
					const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();
					const isCompressed = contentEncoding.split(',').some(encoding => compressedEncodings.has(encoding.trim()));

					const {options} = request;
					// Content-Encoding on a bodyless response describes the representation, not transferred bytes.
					const hasNoBody = isResponseBodyless(options.method, response.statusCode);

					if (isCompressed && !options.decompress && !hasNoBody) {
						response.body = response.rawBody;
					} else {
						try {
							response.body = parseBody(response, options.responseType, options.parseJson, options.encoding);
						} catch (error: unknown) {
							// Preserve the response text when parsing fails.
							try {
								response.body = decodeUint8Array(response.rawBody, options.encoding);
							} catch (error) {
								request._beforeError(new ParseError(error, response));
								return;
							}

							if (isResponseOk(response)) {
								request._beforeError(error);
								return;
							}
						}
					}

					if (request._stopReading) {
						return;
					}

					try {
						const hooks = options.hooks.afterResponse;

						for (const hook of hooks) {
							const previousUrl = options.url ? new URL(options.url) : undefined;
							const previousBoundary = getUrlPrefixBoundary(options);
							const previousState = previousUrl ? snapshotCrossOriginState(options) : undefined;
							const responseSnapshot = response;

							// Retries belong to this attempt even when an earlier hook replaced its response.
							// The retry callback rejects with RetryError rather than returning a response.
							// eslint-disable-next-line no-await-in-loop
							response = await options.trackStateMutations(async changedState => hook(responseSnapshot, async (updatedOptions): Promise<never> => {
								// A cancelled hook can finish later, but its callback no longer owns accepting new options or bodies.
								if (request._stopReading) {
									throw new RetryError(request);
								}

								// Snapshot caller getters before retry decisions and cross-origin checks use them.
								if (is.plainObject(updatedOptions)) {
									updatedOptions = cloneRawOptions(updatedOptions);
								}

								const preserveHooks = updatedOptions.preserveHooks ?? false;

								if (updatedOptions === options) {
									if (hasBodyOptionChanged(changedState)) {
										options.resetUnchangedBodyHeaders(changedState);
									}

									options.applyNextRequestMutations(previousBoundary, previousState, changedState);
								} else {
									options.mergeNextRequestOptions(updatedOptions, {
										previousUrl,
										previousState,
										previousBoundary,
									});
								}

								// RetryError interrupts this loop, so skip all response hooks on the retry by default.
								// preserveHooks explicitly opts into running the complete hook list again.
								if (!preserveHooks) {
									options.hooks.afterResponse = [];
								}

								throw new RetryError(request);
							}));

							// Cancellation or failure can claim the request while an asynchronous hook is pending, before error hooks finish destroying it.
							if (request._stopReading) {
								return;
							}

							if (!(is.object(response) && is.number(response.statusCode) && 'body' in response)) {
								throw new TypeError('The `afterResponse` hook returned an invalid value');
							}

							request.response = response;
						}

						setResponse(response);

						if (request._stopReading) {
							return;
						}
					} catch (error: unknown) {
						request._beforeError(error);
						return;
					}

					if (!response.ok) {
						request._beforeError(new HTTPError(response));
						return;
					}

					resolveWithResponse(response);
				})();
			});

			const onError = (error: RequestError) => {
				// Route errors emitted directly on the stream (e.g., EPIPE from Node.js)
				// through retry logic first, then handle them here after retries are exhausted.
				// See https://github.com/sindresorhus/got/issues/1995
				if (!request.destroyed) {
					request._beforeError(error);
					return;
				}

				// Allow the manual re-emission from Request to settle the promise only once.
				if (promiseSettled) {
					return;
				}

				promiseSettled = true;

				if (error instanceof HTTPError && !request.options.throwHttpErrors) {
					try {
						const {response} = error;
						if (response.rawBody === undefined || !('body' in response)) {
							reject(error);
							return;
						}

						// Suppressing a status error still requires a captured payload before resolving a complete response.
						const completeResponse = response as Response;
						setResponse(completeResponse);
						resolveWithResponse(completeResponse);
					} catch (error) {
						reject(normalizeError(error));
					}

					return;
				}

				reject(error);
			};

			// Use .on() instead of .once() to keep the listener active across retries.
			// Before destruction, we return early and the error gets re-emitted
			// after retry logic completes, so we need this listener to remain active.
			// See https://github.com/sindresorhus/got/issues/1995
			request.on('error', onError);

			let previousBody = request.options?.body;
			request.on('request', () => {
				// Async handlers and beforeRequest hooks can supply the body after this Promise was created.
				previousBody = request.options.body;
			});

			request.once('retry', (newRetryCount: number, error: RequestError) => {
				firstRequest = undefined;

				// If promise already settled, don't retry
				// This prevents the race condition in #1489 where a late error
				// (e.g., ECONNRESET after successful response) triggers retry
				// after the promise has already resolved/rejected
				if (promiseSettled) {
					return;
				}

				const newBody = request.options.body;

				if (previousBody === newBody && isNonReplayableBody(newBody)) {
					error.message = 'Cannot retry with consumed body stream';

					onError(error);
					return;
				}

				// This is needed! We need to reuse `request.options` because they can get modified!
				// For example, by calling `promise.json()`.
				makeRequest(newRetryCount, request.options, request);
			});

			proxyEvents(request, emitter, proxiedRequestEvents);

			if (is.undefined(firstRequest)) {
				void request.flush();
			}
		};

		makeRequest(0);
	}) as RequestPromise<T>;

	for (const method of ['on', 'once', 'off'] as const) {
		promise[method] = function (this: RequestPromise<T>, event: string, function_: (...arguments_: any[]) => void) {
			emitter[method](event, function_);
			return this;
		};
	}

	const shortcut = <T>(promiseToAwait: RequestPromise, responseType: Options['responseType'], schema?: StandardSchemaV1): RequestPromise<T> => {
		const newPromise = (async () => {
			// Wait until downloading has ended
			const response = await promiseToAwait as Response | undefined;

			// Handlers may replace the response or recover one from a request error.
			if (!globalRequest.options.resolveBodyOnly && response?.request instanceof Request && response.rawBody instanceof Uint8Array) {
				globalRequest.response = response;
			}

			// The request owns the selected response, including one recovered before the response hooks completed. Chained shortcuts use the same owner.
			const currentResponse = globalRequest.response as Response;
			const {options} = currentResponse.request;

			// `parseBody` wraps a decode failure in a `ParseError`, so an unusable encoding is
			// reported with the response attached instead of as a bare `TypeError`.
			const body = parseBody(currentResponse, responseType, options.parseJson, options.encoding);

			if (schema === undefined) {
				return body as T;
			}

			// Awaiting instead of returning the validation promise keeps the caller's frame in the
			// async stack trace of a `SchemaValidationError`.
			const validatedBody = await validateWithSchema(body, schema);

			return validatedBody as T;
		})();

		// Only copy Got's methods. Other own properties can be private state from a different Promise implementation.
		copyRequestMethods(promiseToAwait, newPromise);

		return newPromise as RequestPromise<T>;
	};

	// Note: These use `function` syntax (not arrows) to access `this` context.
	// When custom handlers wrap the promise to transform errors, these methods
	// are copied to the handler's promise. Using `this` ensures we await the
	// handler's wrapped promise, not the original, so errors propagate correctly.
	promise.json = function (this: RequestPromise, schema?: StandardSchemaV1) {
		if (globalRequest.options) {
			const {headers} = globalRequest.options;

			// Sanitization removes undefined values, so retain the caller's explicit omission.
			if (!globalRequest.writableFinished && !globalRequest.options.isHeaderExplicitlySet('accept') && !('accept' in headers)) {
				headers.accept = 'application/json';
			}
		}

		return shortcut(this, 'json', schema);
	};

	promise.buffer = function (this: RequestPromise) {
		return shortcut(this, 'buffer');
	};

	promise.text = function (this: RequestPromise) {
		return shortcut(this, 'text');
	};

	return {
		promise,
		get request() {
			return globalRequest;
		},
	};
}
