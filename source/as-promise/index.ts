import {EventEmitter} from 'events';
import getStream = require('get-stream');
import PCancelable = require('p-cancelable');
import calculateRetryDelay from './calculate-retry-delay';
import {
	NormalizedOptions,
	CancelableRequest,
	Response,
	RequestError,
	HTTPError
} from './types';
import PromisableRequest, {parseBody} from './core';
import proxyEvents from '../core/utils/proxy-events';

const proxiedRequestEvents = [
	'request',
	'response',
	'redirect',
	'uploadProgress',
	'downloadProgress'
];

export default function asPromise<T>(options: NormalizedOptions): CancelableRequest<T> {
	let retryCount = 0;
	let globalRequest: PromisableRequest;
	let globalResponse: Response;
	const emitter = new EventEmitter();

	const promise = new PCancelable<T>((resolve, _reject, onCancel) => {
		const makeRequest = (): void => {
			// Support retries
			// `options.throwHttpErrors` needs to be always true,
			// so the HTTP errors are caught and the request is retried.
			// The error is **eventually** thrown if the user value is true.
			const {throwHttpErrors} = options;
			if (!throwHttpErrors) {
				options.throwHttpErrors = true;
			}

			// Note from @szmarczak: I think we should use `request.options` instead of the local options
			const request = new PromisableRequest(options.url, options);
			request._noPipe = true;
			onCancel(() => request.destroy());

			const reject = async (error: RequestError) => {
				try {
					for (const hook of options.hooks.beforeError) {
						// eslint-disable-next-line no-await-in-loop
						error = await hook(error);
					}
				} catch (error_) {
					_reject(new RequestError(error_.message, error_, request));
					return;
				}

				_reject(error);
			};

			globalRequest = request;

			const onResponse = async (response: Response) => {
				response.retryCount = retryCount;

				if (response.request.aborted) {
					// Canceled while downloading - will throw a `CancelError` or `TimeoutError` error
					return;
				}

				const isOk = (): boolean => {
					const {statusCode} = response;
					const limitStatusCode = options.followRedirect ? 299 : 399;

					return (statusCode >= 200 && statusCode <= limitStatusCode) || statusCode === 304;
				};

				// Download body
				let rawBody;
				try {
					rawBody = await getStream.buffer(request);

					response.rawBody = rawBody;
				} catch (_) {
					// The same error is caught below.
					// See request.once('error')
					return;
				}

				// Parse body
				try {
					response.body = parseBody(response, options.responseType, options.parseJson, options.encoding);
				} catch (error) {
					// Fallback to `utf8`
					response.body = rawBody.toString();

					if (isOk()) {
						// TODO: Call `request._beforeError`, see https://github.com/nodejs/node/issues/32995
						reject(error);
						return;
					}
				}

				try {
					for (const [index, hook] of options.hooks.afterResponse.entries()) {
						// @ts-ignore TS doesn't notice that CancelableRequest is a Promise
						// eslint-disable-next-line no-await-in-loop
						response = await hook(response, async (updatedOptions): CancelableRequest<Response> => {
							const typedOptions = PromisableRequest.normalizeArguments(undefined, {
								...updatedOptions,
								retry: {
									calculateDelay: () => 0
								},
								throwHttpErrors: false,
								resolveBodyOnly: false
							}, options);

							// Remove any further hooks for that request, because we'll call them anyway.
							// The loop continues. We don't want duplicates (asPromise recursion).
							typedOptions.hooks.afterResponse = typedOptions.hooks.afterResponse.slice(0, index);

							for (const hook of typedOptions.hooks.beforeRetry) {
								// eslint-disable-next-line no-await-in-loop
								await hook(typedOptions);
							}

							const promise: CancelableRequest<Response> = asPromise(typedOptions);

							onCancel(() => {
								promise.catch(() => {});
								promise.cancel();
							});

							return promise;
						});
					}
				} catch (error) {
					// TODO: Call `request._beforeError`, see https://github.com/nodejs/node/issues/32995
					reject(new RequestError(error.message, error, request));
					return;
				}

				if (throwHttpErrors && !isOk()) {
					reject(new HTTPError(response));
					return;
				}

				globalResponse = response;

				resolve(options.resolveBodyOnly ? response.body as T : response as unknown as T);
			};

			const onError = async (error: RequestError) => {
				if (promise.isCanceled) {
					return;
				}

				if (!request.options) {
					reject(error);
					return;
				}

				request.off('response', onResponse);

				let backoff: number;

				retryCount++;

				try {
					backoff = await options.retry.calculateDelay({
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
					// Don't emit the `response` event
					request.destroy();

					reject(new RequestError(error_.message, error, request));
					return;
				}

				if (backoff) {
					// Don't emit the `response` event
					request.destroy();

					const retry = async (): Promise<void> => {
						options.throwHttpErrors = throwHttpErrors;

						try {
							for (const hook of options.hooks.beforeRetry) {
								// eslint-disable-next-line no-await-in-loop
								await hook(options, error, retryCount);
							}
						} catch (error_) {
							// Don't emit the `response` event
							request.destroy();

							reject(new RequestError(error_.message, error, request));
							return;
						}

						makeRequest();
					};

					setTimeout(retry, backoff);
					return;
				}

				// The retry has not been made
				retryCount--;

				if (error instanceof HTTPError) {
					// The error will be handled by the `response` event
					onResponse(request._response as Response);

					// Reattach the error handler, because there may be a timeout later.
					process.nextTick(() => {
						request.once('error', onError);
					});
					return;
				}

				// Don't emit the `response` event
				request.destroy();

				reject(error);
			};

			request.once('response', onResponse);
			request.once('error', onError);

			proxyEvents(request, emitter, proxiedRequestEvents);
		};

		makeRequest();
	}) as CancelableRequest<T>;

	promise.on = (event: string, fn: (...args: any[]) => void) => {
		emitter.on(event, fn);
		return promise;
	};

	const shortcut = <T>(responseType: NormalizedOptions['responseType']): CancelableRequest<T> => {
		const newPromise = (async () => {
			// Wait until downloading has ended
			await promise;

			return parseBody(globalResponse, responseType, options.parseJson, options.encoding);
		})();

		Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promise));

		return newPromise as CancelableRequest<T>;
	};

	promise.json = () => {
		if (!globalRequest.writableFinished && options.headers.accept === undefined) {
			options.headers.accept = 'application/json';
		}

		return shortcut('json');
	};

	promise.buffer = () => shortcut('buffer');
	promise.text = () => shortcut('text');

	return promise;
}

export * from './types';
export {PromisableRequest};
