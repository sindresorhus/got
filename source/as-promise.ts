import EventEmitter = require('events');
import getStream = require('get-stream');
import PCancelable = require('p-cancelable');
import is from '@sindresorhus/is';
import {ParseError, ReadError, HTTPError} from './errors';
import {normalizeArguments, mergeOptions} from './normalize-arguments';
import requestAsEventEmitter, {proxyEvents} from './request-as-event-emitter';
import {CancelableRequest, GeneralError, NormalizedOptions, Response} from './types';

const parseBody = (body: Buffer, responseType: NormalizedOptions['responseType'], encoding: NormalizedOptions['encoding']): unknown => {
	if (responseType === 'json') {
		return body.length === 0 ? '' : JSON.parse(body.toString());
	}

	if (responseType === 'buffer') {
		return Buffer.from(body);
	}

	if (responseType === 'text') {
		return body.toString(encoding);
	}

	throw new TypeError(`Unknown body type '${responseType as string}'`);
};

export function createRejection(error: Error): CancelableRequest<never> {
	const promise = Promise.reject(error) as CancelableRequest<never>;
	const returnPromise = (): CancelableRequest<never> => promise;

	promise.json = returnPromise;
	promise.text = returnPromise;
	promise.buffer = returnPromise;
	promise.on = returnPromise;

	return promise;
}

export default function asPromise<T>(options: NormalizedOptions): CancelableRequest<T> {
	const proxy = new EventEmitter();
	let body: Buffer;

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

			// Download body
			try {
				body = await getStream.buffer(response, {encoding: 'binary'});
			} catch (error) {
				emitError(new ReadError(error, options));
				return;
			}

			if (response.req?.aborted) {
				// Canceled while downloading - will throw a `CancelError` or `TimeoutError` error
				return;
			}

			const isOk = (): boolean => {
				const {statusCode} = response;
				const limitStatusCode = options.followRedirect ? 299 : 399;

				return (statusCode >= 200 && statusCode <= limitStatusCode) || statusCode === 304;
			};

			// Parse body
			try {
				response.body = parseBody(body, options.responseType, options.encoding);
			} catch (error) {
				// Fall back to `utf8`
				response.body = body.toString();

				if (isOk()) {
					const parseError = new ParseError(error, response, options);
					emitError(parseError);
					return;
				}
			}

			try {
				for (const [index, hook] of options.hooks.afterResponse.entries()) {
					// @ts-ignore TS doesn't notice that CancelableRequest is a Promise
					// eslint-disable-next-line no-await-in-loop
					response = await hook(response, async (updatedOptions): CancelableRequest<Response> => {
						const typedOptions = normalizeArguments(mergeOptions(options, {
							...updatedOptions,
							retry: {
								calculateDelay: () => 0
							},
							throwHttpErrors: false,
							resolveBodyOnly: false
						}));

						// Remove any further hooks for that request, because we'll call them anyway.
						// The loop continues. We don't want duplicates (asPromise recursion).
						typedOptions.hooks.afterResponse = options.hooks.afterResponse.slice(0, index);

						for (const hook of options.hooks.beforeRetry) {
							// eslint-disable-next-line no-await-in-loop
							await hook(typedOptions);
						}

						const promise = asPromise(typedOptions);

						onCancel(() => {
							promise.catch(() => {});
							promise.cancel();
						});

						return promise as unknown as CancelableRequest<Response>;
					});
				}
			} catch (error) {
				emitError(error);
				return;
			}

			// Check for HTTP error codes
			if (!isOk()) {
				const error = new HTTPError(response, options);

				if (emitter.retry(error)) {
					return;
				}

				if (options.throwHttpErrors) {
					emitError(error);
					return;
				}
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
		const newPromise = promise.then(() => parseBody(body, responseType, options.encoding));

		Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promise));

		return newPromise as CancelableRequest<T>;
	};

	promise.json = () => {
		if (is.undefined(body) && is.undefined(options.headers.accept)) {
			options.headers.accept = 'application/json';
		}

		return shortcut('json');
	};

	promise.buffer = () => shortcut('buffer');
	promise.text = () => shortcut('text');

	return promise;
}
