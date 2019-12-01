import EventEmitter = require('events');
import getStream = require('get-stream');
import PCancelable = require('p-cancelable');
import is from '@sindresorhus/is';
import {ParseError, ReadError, HTTPError} from './errors';
import {normalizeArguments, mergeOptions} from './normalize-arguments';
import requestAsEventEmitter, {proxyEvents} from './request-as-event-emitter';
import {CancelableRequest, GeneralError, NormalizedOptions, Response} from './utils/types';

const parseBody = (body: Response['body'], responseType: NormalizedOptions['responseType'], statusCode: Response['statusCode']): unknown => {
	if (responseType === 'json' && is.string(body)) {
		return statusCode === 204 ? '' : JSON.parse(body);
	}

	if (responseType === 'buffer' && is.string(body)) {
		return Buffer.from(body);
	}

	if (responseType === 'text') {
		return String(body);
	}

	if (responseType === 'default') {
		return body;
	}

	throw new Error(`Failed to parse body of type '${typeof body}' as '${responseType!}'`);
};

export default function asPromise<T>(options: NormalizedOptions): CancelableRequest<T> {
	const proxy = new EventEmitter();
	let finalResponse: Pick<Response, 'body' | 'statusCode'>;

	// @ts-ignore `.json()`, `.buffer()` and `.text()` are added later
	const promise = new PCancelable<Response | Response['body']>((resolve, reject, onCancel) => {
		const emitter = requestAsEventEmitter(options);
		onCancel(emitter.abort);

		const emitError = async (error: GeneralError): Promise<void> => {
			try {
				for (const hook of options.hooks.beforeError) {
					// eslint-disable-next-line no-await-in-loop
					error = await hook(error);
				}

				reject(error);
			} catch (error_) {
				reject(error_);
			}
		};

		emitter.on('response', async (response: Response) => {
			proxy.emit('response', response);

			try {
				response.body = await getStream(response, {encoding: options.encoding});
			} catch (error) {
				emitError(new ReadError(error, options));
				return;
			}

			if (response.req?.aborted) {
				// Canceled while downloading - will throw a `CancelError` or `TimeoutError` error
				return;
			}

			try {
				for (const [index, hook] of options.hooks.afterResponse.entries()) {
					// @ts-ignore Promise is not assignable to CancelableRequest
					// eslint-disable-next-line no-await-in-loop
					response = await hook(response, async (updatedOptions: NormalizedOptions) => {
						updatedOptions = normalizeArguments(mergeOptions(options, {
							...updatedOptions,
							retry: {
								calculateDelay: () => 0
							},
							throwHttpErrors: false,
							responseType: 'text',
							resolveBodyOnly: false
						}));

						// Remove any further hooks for that request, because we'll call them anyway.
						// The loop continues. We don't want duplicates (asPromise recursion).
						updatedOptions.hooks.afterResponse = options.hooks.afterResponse.slice(0, index);

						for (const hook of options.hooks.beforeRetry) {
							// eslint-disable-next-line no-await-in-loop
							await hook(updatedOptions);
						}

						const promise = asPromise(updatedOptions);

						onCancel(() => {
							promise.catch(() => {});
							promise.cancel();
						});

						return promise;
					});
				}
			} catch (error) {
				emitError(error);
				return;
			}

			const {statusCode} = response;

			finalResponse = {
				body: response.body,
				statusCode
			};

			try {
				response.body = parseBody(response.body, options.responseType, response.statusCode);
			} catch (error) {
				if (statusCode >= 200 && statusCode < 300) {
					const parseError = new ParseError(error, response, options);
					emitError(parseError);
					return;
				}
			}

			const limitStatusCode = options.followRedirect ? 299 : 399;
			if (statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const error = new HTTPError(response, options);
				if (!emitter.retry(error)) {
					if (options.throwHttpErrors) {
						emitError(error);
						return;
					}

					resolve(options.resolveBodyOnly ? response.body : response);
				}

				return;
			}

			resolve(options.resolveBodyOnly ? response.body : response);
		});

		emitter.once('error', reject);

		proxyEvents(proxy, emitter);
	}) as CancelableRequest<T>;

	promise.on = (name: string, fn: (...args: any[]) => void) => {
		proxy.on(name, fn);
		return promise;
	};

	const shortcut = <T>(responseType: NormalizedOptions['responseType']): CancelableRequest<T> => {
		// eslint-disable-next-line promise/prefer-await-to-then
		const newPromise = promise.then(() => parseBody(finalResponse.body, responseType, finalResponse.statusCode));

		Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promise));

		return newPromise as CancelableRequest<T>;
	};

	promise.json = () => {
		if (is.undefined(options.headers.accept)) {
			options.headers.accept = 'application/json';
		}

		return shortcut('json');
	};

	promise.buffer = () => shortcut('buffer');
	promise.text = () => shortcut('text');

	return promise;
}
