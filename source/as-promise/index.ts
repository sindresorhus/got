import {EventEmitter} from 'events';
import is from '@sindresorhus/is';
import * as PCancelable from 'p-cancelable';
import {
	RequestError,
	HTTPError,
	RetryError
} from '../core/errors';
import {CancelError} from './types';
import Request from '../core';
import {parseBody, isResponseOk} from '../core/response';
import proxyEvents from '../core/utils/proxy-events';
import type Options from '../core/options';
import type {Response} from '../core/response';
import type {CancelableRequest} from './types';

const proxiedRequestEvents = [
	'request',
	'response',
	'redirect',
	'uploadProgress',
	'downloadProgress'
];

const supportedCompressionAlgorithms = new Set(['gzip', 'deflate', 'br']);

export default function asPromise<T>(firstRequest: Request): CancelableRequest<T> {
	let globalRequest: Request;
	let globalResponse: Response;
	let normalizedOptions: Options;
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
			// Errors when a new request is made after the promise settles.
			// Seems like a race condition, because we were not able to reproduce this.
			// FIXME: After the promise settles, there must be no further requests.
			// See https://github.com/sindresorhus/got/issues/1489
			onCancel(() => {});

			const request = retryCount === 0 ? firstRequest : new Request(undefined, normalizedOptions);
			request.retryCount = retryCount;
			request._noPipe = true;

			globalRequest = request;

			request.once('response', async (response: Response) => {
				// Parse body
				const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();
				const isCompressed = supportedCompressionAlgorithms.has(contentEncoding);

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
					const hooks = options.hooks.afterResponse;

					// TODO: `xo` should detect if `index` is being used for something else
					// eslint-disable-next-line unicorn/no-for-loop
					for (let index = 0; index < hooks.length; index++) {
						const hook = hooks[index];

						// @ts-expect-error TS doesn't notice that CancelableRequest is a Promise
						// eslint-disable-next-line no-await-in-loop
						response = await hook(response, async (updatedOptions): CancelableRequest<Response> => {
							options.merge(updatedOptions);

							// Remove any further hooks for that request, because we'll call them anyway.
							// The loop continues. We don't want duplicates (asPromise recursion).
							options.hooks.afterResponse = options.hooks.afterResponse.slice(0, index);

							throw new RetryError(request);
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

				request.destroy();
				resolve(request.options.resolveBodyOnly ? response.body as T : response as unknown as T);
			});

			const onError = (error: RequestError) => {
				if (promise.isCanceled) {
					return;
				}

				const {options} = request;

				if (error instanceof HTTPError && !options.throwHttpErrors) {
					const {response} = error;

					request.destroy();
					resolve(request.options.resolveBodyOnly ? response.body as T : response as unknown as T);
					return;
				}

				reject(error);
			};

			request.once('error', onError);

			const previousBody = request.options.body;

			request.once('retry', (newRetryCount: number, error: RequestError) => {
				const newBody = request.options.body;

				if (previousBody === newBody && is.nodeStream(newBody)) {
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
