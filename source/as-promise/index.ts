import {EventEmitter} from 'events';
import is from '@sindresorhus/is';
import PCancelable = require('p-cancelable');
import {
	NormalizedOptions,
	CancelableRequest,
	Response,
	RequestError,
	HTTPError,
	CancelError
} from './types';
import parseBody from './parse-body';
import Request from '../core';
import proxyEvents from '../core/utils/proxy-events';
import getBuffer from '../core/utils/get-buffer';
import {isResponseOk} from '../core/utils/is-response-ok';

const proxiedRequestEvents = [
	'request',
	'response',
	'redirect',
	'uploadProgress',
	'downloadProgress'
];

export default function asPromise<T>(normalizedOptions: NormalizedOptions): CancelableRequest<T> {
	let globalRequest: Request;
	let globalResponse: Response;
	const emitter = new EventEmitter();

	const promise = new PCancelable<T>((resolve, reject, onCancel) => {
		const makeRequest = (retryCount: number): void => {
			const request = new Request(undefined, normalizedOptions);
			request.retryCount = retryCount;
			request._noPipe = true;

			onCancel(() => request.destroy());

			onCancel.shouldReject = false;
			onCancel(() => reject(new CancelError(request)));

			globalRequest = request;

			request.once('response', async (response: Response) => {
				response.retryCount = retryCount;

				if (response.request.aborted) {
					// Canceled while downloading - will throw a `CancelError` or `TimeoutError` error
					return;
				}

				// Download body
				let rawBody;
				try {
					rawBody = await getBuffer(request);
					response.rawBody = rawBody;
				} catch {
					// The same error is caught below.
					// See request.once('error')
					return;
				}

				if (request._isAboutToError) {
					return;
				}

				// Parse body
				const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();
				const isCompressed = ['gzip', 'deflate', 'br'].includes(contentEncoding);

				const {options} = request;

				if (isCompressed && !options.decompress) {
					response.body = rawBody;
				} else {
					try {
						response.body = parseBody(response, options.responseType, options.parseJson, options.encoding);
					} catch (error) {
						// Fallback to `utf8`
						response.body = rawBody.toString();

						if (isResponseOk(response)) {
							request._beforeError(error);
							return;
						}
					}
				}

				try {
					for (const [index, hook] of options.hooks.afterResponse.entries()) {
						// @ts-expect-error TS doesn't notice that CancelableRequest is a Promise
						// eslint-disable-next-line no-await-in-loop
						response = await hook(response, async (updatedOptions): CancelableRequest<Response> => {
							const typedOptions = Request.normalizeArguments(undefined, {
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
					request._beforeError(new RequestError(error.message, error, request));
					return;
				}

				if (!isResponseOk(response)) {
					request._beforeError(new HTTPError(response));
					return;
				}

				globalResponse = response;

				resolve(request.options.resolveBodyOnly ? response.body as T : response as unknown as T);
			});

			const onError = (error: RequestError) => {
				if (promise.isCanceled) {
					return;
				}

				const {options} = request;

				if (error instanceof HTTPError && !options.throwHttpErrors) {
					const {response} = error;
					resolve(request.options.resolveBodyOnly ? response.body as T : response as unknown as T);
					return;
				}

				reject(error);
			};

			request.once('error', onError);

			const previousBody = request.options.body;

			request.once('retry', (newRetryCount: number, error: RequestError) => {
				if (previousBody === error.request?.options.body && is.nodeStream(error.request?.options.body)) {
					onError(error);
					return;
				}

				makeRequest(newRetryCount);
			});

			proxyEvents(request, emitter, proxiedRequestEvents);
		};

		makeRequest(0);
	}) as CancelableRequest<T>;

	promise.on = (event: string, fn: (...args: any[]) => void) => {
		emitter.on(event, fn);
		return promise;
	};

	const shortcut = <T>(responseType: NormalizedOptions['responseType']): CancelableRequest<T> => {
		const newPromise = (async () => {
			// Wait until downloading has ended
			await promise;

			const {options} = globalResponse.request;

			return parseBody(globalResponse, responseType, options.parseJson, options.encoding);
		})();

		Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promise));

		return newPromise as CancelableRequest<T>;
	};

	promise.json = () => {
		const {headers} = globalRequest.options;

		if (!globalRequest.writableFinished && headers.accept === undefined) {
			headers.accept = 'application/json';
		}

		return shortcut('json');
	};

	promise.buffer = () => shortcut('buffer');
	promise.text = () => shortcut('text');

	return promise;
}

export * from './types';
