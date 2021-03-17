import {EventEmitter} from 'events';
import is from '@sindresorhus/is';
import * as PCancelable from 'p-cancelable';
import Options from '../core/options';
import type {Response} from '../core/response';
import {
	CancelableRequest
} from './types';
import {
	RequestError,
	HTTPError
} from '../core/errors';
import {CancelError} from './types';
import {parseBody} from '../core/response';
import Request from '../core';
import {isResponseOk} from '../core/response';
import proxyEvents from '../core/utils/proxy-events';

const proxiedRequestEvents = [
	'request',
	'response',
	'redirect',
	'uploadProgress',
	'downloadProgress'
];

export default function asPromise<T>(normalizedOptions: Options): CancelableRequest<T> {
	let globalRequest: Request;
	let globalResponse: Response;
	const emitter = new EventEmitter();

	const promise = new PCancelable<T>((resolve, reject, onCancel) => {
		onCancel(() => {
			globalRequest.destroy();
		});

		onCancel.shouldReject = false;
		onCancel(() => {
			reject(new CancelError(globalRequest));
		});

		const makeRequest = (retryCount: number): void => {
			const request = new Request(undefined, normalizedOptions);
			request.retryCount = retryCount;
			request._noPipe = true;

			globalRequest = request;

			request.once('response', async (response: Response) => {
				if (request._isAboutToError) {
					return;
				}

				// Parse body
				const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();
				const isCompressed = ['gzip', 'deflate', 'br'].includes(contentEncoding);

				const {options} = request;

				if (isCompressed && !options.decompress) {
					response.body = response.rawBody;
				} else {
					try {
						response.body = parseBody(response, options.responseType, options.parseJson, options.encoding);
					} catch (error) {
						// Fallback to `utf8`
						response.body = response.rawBody.toString();

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
							const typedOptions = new Options(updatedOptions, options);
							typedOptions.retry.calculateDelay = () => 0;
							typedOptions.throwHttpErrors = false;
							typedOptions.resolveBodyOnly = false;

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

				globalResponse = response;

				if (!isResponseOk(response)) {
					request._beforeError(new HTTPError(response));
					return;
				}

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

				// This is needed! We need to reuse `request.options` because they can get modified!
				// For example, by calling `promise.json()`.
				normalizedOptions = request.options;

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

	const shortcut = <T>(responseType: Options['responseType']): CancelableRequest<T> => {
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
