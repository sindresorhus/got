import {URL} from 'url';
import is, {assert} from '@sindresorhus/is';
import {
	Options,
	NormalizedOptions,
	Defaults,
	ResponseType
} from './types';
import Request, {knownHookEvents, RequestError, HTTPError, Method} from '../core';

if (!knownHookEvents.includes('beforeRetry' as any)) {
	knownHookEvents.push('beforeRetry' as any, 'afterResponse' as any);
}

export const knownBodyTypes = ['json', 'buffer', 'text'];

// @ts-ignore The error is: Not all code paths return a value.
export const parseBody = (body: Buffer, responseType: ResponseType, encoding?: string): unknown => {
	if (responseType === 'text') {
		return body.toString(encoding);
	}

	if (responseType === 'json') {
		return body.length === 0 ? '' : JSON.parse(body.toString()) as unknown;
	}

	if (responseType === 'buffer') {
		return Buffer.from(body);
	}

	if (!knownBodyTypes.includes(responseType)) {
		throw new TypeError(`Unknown body type '${responseType as string}'`);
	}
};

export default class PromisableRequest extends Request {
	['constructor']: typeof PromisableRequest;
	declare options: NormalizedOptions;
	declare _throwHttpErrors: boolean;

	static normalizeArguments(url?: string | URL, nonNormalizedOptions?: Options, defaults?: Defaults): NormalizedOptions {
		const options = super.normalizeArguments(url, nonNormalizedOptions, defaults) as NormalizedOptions;

		if (is.null_(options.encoding)) {
			throw new TypeError('To get a Buffer, set `options.responseType` to `buffer` instead');
		}

		assert.any([is.string, is.undefined], options.encoding);
		assert.any([is.boolean, is.undefined], options.resolveBodyOnly);
		assert.any([is.boolean, is.undefined], options.methodRewriting);
		assert.any([is.boolean, is.undefined], options.isStream);

		// `options.retry`
		const {retry} = options;

		if (defaults) {
			options.retry = {...defaults.retry};
		} else {
			options.retry = {
				calculateDelay: retryObject => retryObject.computedValue,
				limit: 0,
				methods: [],
				statusCodes: [],
				errorCodes: [],
				maxRetryAfter: undefined
			};
		}

		if (is.object(retry)) {
			options.retry = {
				...options.retry,
				...retry
			};

			options.retry.methods = [...new Set(options.retry.methods.map(method => method.toUpperCase() as Method))];
			options.retry.statusCodes = [...new Set(options.retry.statusCodes)];
			options.retry.errorCodes = [...new Set(options.retry.errorCodes)];
		} else if (is.number(retry)) {
			options.retry.limit = retry;
		}

		if (is.undefined(options.retry.maxRetryAfter)) {
			options.retry.maxRetryAfter = Math.min(
				...[options.timeout.request, options.timeout.connect].filter(is.number)
			);
		}

		// `options.pagination`
		if (is.object(options.pagination)) {
			if (defaults) {
				(options as Options).pagination = {
					...defaults.pagination,
					...options.pagination
				};
			}

			const {pagination} = options;

			if (!is.function_(pagination.transform)) {
				throw new Error('`options.pagination.transform` must be implemented');
			}

			if (!is.function_(pagination.shouldContinue)) {
				throw new Error('`options.pagination.shouldContinue` must be implemented');
			}

			if (!is.function_(pagination.filter)) {
				throw new TypeError('`options.pagination.filter` must be implemented');
			}

			if (!is.function_(pagination.paginate)) {
				throw new Error('`options.pagination.paginate` must be implemented');
			}
		}

		return options;
	}

	static mergeOptions(...sources: Options[]): NormalizedOptions {
		let mergedOptions: NormalizedOptions | undefined;

		for (const source of sources) {
			mergedOptions = PromisableRequest.normalizeArguments(undefined, source, mergedOptions);
		}

		return mergedOptions!;
	}

	async _beforeError(error: RequestError): Promise<void> {
		const isHTTPError = error instanceof HTTPError;

		try {
			for (const hook of this.options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}
		} catch (error_) {
			this.destroy(error_);
			return;
		}

		if (this._throwHttpErrors && isHTTPError) {
			this.emit('error', error);
		} else {
			this.destroy(error);
		}
	}
}
