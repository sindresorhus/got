import {EventEmitter} from 'events';
import is from '@sindresorhus/is';
import PCancelable from 'p-cancelable';
import {
	RequestError,
	HTTPError,
	RetryError,
} from '../core/errors.js';
import Request from '../core/index.js';
import {parseBody, isResponseOk} from '../core/response.js';
import proxyEvents from '../core/utils/proxy-events.js';
import type Options from '../core/options.js';
import type {Response} from '../core/response.js';
import {CancelError} from './types.js';
import type {CancelableRequest} from './types.js';

const proxiedRequestEvents = [
	'request',
	'response',
	'redirect',
	'uploadProgress',
	'downloadProgress',
];

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
			// Used to detect a race condition.
			// See https://github.com/sindresorhus/got/issues/1489
			onCancel(() => {});

			const request = firstRequest ?? new Request(undefined, undefined, normalizedOptions);
			request.retryCount = retryCount;
			request._noPipe = true;

			globalRequest = request;

			request.once('response', async (response: Response) => {
				// Parse body
				const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();
				const isCompressed = contentEncoding === 'gzip' || contentEncoding === 'defalte' || contentEncoding === 'br';

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
							options.prefixUrl = '';

							if (updatedOptions.url) {
								options.url = updatedOptions.url;
							}

							// Remove any further hooks for that request, because we'll call them anyway.
							// The loop continues. We don't want duplicates (asPromise recursion).
							options.hooks.afterResponse = options.hooks.afterResponse.slice(0, index);

							throw new RetryError(request);
						});

						if (!(is.object(response) && is.number(response.statusCode) && response.body)) {
							throw new TypeError('The `afterResponse` hook returned an invalid value');
						}
					}
				} catch (error) {
					request._beforeError(error);
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

			const previousBody = request.options?.body;

			request.once('retry', (newRetryCount: number, error: RequestError) => {
				// @ts-expect-error
				firstRequest = undefined;

				const newBody = request.options.body;

				if (previousBody === newBody && is.nodeStream(newBody)) {
					error.message = 'Cannot retry with consumed body stream';

					onError(error);
					return;
				}

				// This is needed! We need to reuse `request.options` because they can get modified!
				// For example, by calling `promise.json()`.
				normalizedOptions = request.options;

				makeRequest(newRetryCount);
			});

			proxyEvents(request, emitter, proxiedRequestEvents);

			if (is.undefined(firstRequest)) {
				void request.flush();
			}
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

		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promise));

		return newPromise as CancelableRequest<T>;
	};

	promise.json = () => {
		if (globalRequest.options) {
			const {headers} = globalRequest.options;

			if (!globalRequest.writableFinished && !('accept' in headers)) {
				headers.accept = 'application/json';
			}
		}

		return shortcut('json');
	};

	promise.buffer = () => shortcut('buffer');
	promise.text = () => shortcut('text');

	return promise;
}
