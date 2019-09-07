import {IncomingMessage} from 'http';
import EventEmitter = require('events');
import getStream = require('get-stream');
import is from '@sindresorhus/is';
import PCancelable = require('p-cancelable');
import {NormalizedOptions, Response, CancelableRequest} from './utils/types';
import {mergeOptions} from './merge';
import {ParseError, ReadError, HTTPError} from './errors';
import {reNormalizeArguments} from './normalize-arguments';
import requestAsEventEmitter from './request-as-event-emitter';

type ResponseReturn = Response | Buffer | string | any;

export const isProxiedSymbol = Symbol('proxied');

export default function asPromise(options: NormalizedOptions): CancelableRequest<Response> {
	const proxy = new EventEmitter();

	const parseBody = (response: Response): void => {
		if (options.responseType === 'json') {
			response.body = JSON.parse(response.body);
		} else if (options.responseType === 'buffer') {
			response.body = Buffer.from(response.body);
		} else if (options.responseType !== 'text' && !is.falsy(options.responseType)) {
			throw new Error(`Failed to parse body of type '${options.responseType}'`);
		}
	};

	const promise = new PCancelable<IncomingMessage>((resolve, reject, onCancel) => {
		const emitter = requestAsEventEmitter(options);
		onCancel(emitter.abort);

		const emitError = async (error: Error): Promise<void> => {
			try {
				for (const hook of options.hooks.beforeError) {
					// eslint-disable-next-line no-await-in-loop
					error = await hook(error);
				}

				reject(error);
			} catch (error2) {
				reject(error2);
			}
		};

		emitter.on('response', async (response: Response) => {
			proxy.emit('response', response);

			const stream = is.null_(options.encoding) ? getStream.buffer(response) : getStream(response, {encoding: options.encoding});

			let data: Buffer | string;
			try {
				data = await stream;
			} catch (error) {
				emitError(new ReadError(error, options));
				return;
			}

			if (response.req && response.req.aborted) {
				// Canceled while downloading - will throw a CancelError or TimeoutError
				return;
			}

			const limitStatusCode = options.followRedirect ? 299 : 399;

			response.body = data;

			try {
				for (const [index, hook] of options.hooks.afterResponse.entries()) {
					// eslint-disable-next-line no-await-in-loop
					response = await hook(response, updatedOptions => {
						updatedOptions = reNormalizeArguments(mergeOptions(options, {
							...updatedOptions,
							// @ts-ignore TS complaining that it's missing properties, which get merged
							retry: {
								retries: () => 0
							},
							throwHttpErrors: false,
							responseType: 'text',
							resolveBodyOnly: false
						}));

						// Remove any further hooks for that request, because we we'll call them anyway.
						// The loop continues. We don't want duplicates (asPromise recursion).
						updatedOptions.hooks.afterResponse = options.hooks.afterResponse.slice(0, index);

						return asPromise(updatedOptions);
					});
				}
			} catch (error) {
				emitError(error);
				return;
			}

			const {statusCode} = response;

			if (response.body) {
				try {
					parseBody(response);
				} catch (error) {
					if (statusCode >= 200 && statusCode < 300) {
						const parseError = new ParseError(error, response, options);
						emitError(parseError);
						return;
					}
				}
			}

			if (statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
				const error = new HTTPError(response, options);
				if (emitter.retry(error) === false) {
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
		[
			'request',
			'redirect',
			'uploadProgress',
			'downloadProgress'
		].forEach(event => emitter.on(event, (...args: unknown[]) => {
			proxy.emit(event, ...args);
		}));
	}) as CancelableRequest<ResponseReturn>;

	promise[isProxiedSymbol] = true;

	promise.on = (name, fn) => {
		proxy.on(name, fn);
		return promise;
	};

	promise.json = () => {
		options.responseType = 'json';
		options.resolveBodyOnly = true;
		return promise;
	};

	promise.buffer = () => {
		options.responseType = 'buffer';
		options.resolveBodyOnly = true;
		return promise;
	};

	promise.text = () => {
		options.responseType = 'text';
		options.resolveBodyOnly = true;
		return promise;
	};

	return promise;
}
