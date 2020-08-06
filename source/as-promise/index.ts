import {EventEmitter} from 'events';
import PCancelable = require('p-cancelable');
import {
	NormalizedOptions,
	CancelableRequest,
	Response,
	RequestError,
	HTTPError
} from './types';
import PromisableRequest, {parseBody} from './core';
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

export default function asPromise<T>(options: NormalizedOptions): CancelableRequest<T> {
	let globalRequest: PromisableRequest;
	let globalResponse: Response;
	const emitter = new EventEmitter();

	const promise = new PCancelable<T>((resolve, reject, onCancel) => {
		const makeRequest = (retryCount: number): void => {
			// Note from @szmarczak: I think we should use `request.options` instead of the local options
			const request = new PromisableRequest(options.url, options);
			request.retryCount = retryCount;
			request._noPipe = true;
			onCancel(() => request.destroy());

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

			request.once('error', async (error: RequestError) => {
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
			});

			request.once('retry', (newRetryCount: number) => {
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
export {PromisableRequest};
