// @ts-nocheck
import {URL} from 'url';
import is from '@sindresorhus/is';
import asPromise from './as-promise';
import {
	GotReturn,
	ExtendOptions,
	Got,
	HTTPAlias,
	HandlerFunction,
	InstanceDefaults,
	GotPaginate,
	GotStream,
	GotRequestFunction,
	OptionsWithPagination,
	StreamOptions
} from './types';
import Request from './core/index';
import Options, {OptionsInit} from './core/options';
import type {CancelableRequest} from './as-promise/types';

// The `delay` package weighs 10KB (!)
const delay = async (ms: number) => new Promise(resolve => {
	setTimeout(resolve, ms);
});

const isGotInstance = (value: Got | ExtendOptions): value is Got => (
	'defaults' in value && 'options' in value.defaults
);

const aliases: readonly HTTPAlias[] = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

export const defaultHandler: HandlerFunction = (options, next) => next(options);

const create = (defaults: InstanceDefaults): Got => {
	// Got interface
	const got: Got = ((url: string | URL | OptionsInit | Options | undefined, options?: OptionsInit | Options, defaultOptions: Options = defaults.options): GotReturn => {
		const request = new Request(url, options, defaultOptions);
		let promise: CancelableRequest;

		const lastHandler = (options: Options): GotReturn => {
			request.options = options;
			request._noPipe = !options.isStream;
			void request.flush();

			if (options.isStream) {
				return request;
			}

			if (!promise) {
				promise = asPromise(request);
			}

			return promise;
		};

		let iteration = 0;
		const iterateHandlers = (newOptions: Options): GotReturn => {
			// TODO: Remove the `!`. This could probably be simplified to not use index access.
			return defaults.handlers[iteration++]!(
				newOptions,
				iteration === defaults.handlers.length ? lastHandler : iterateHandlers
			) as GotReturn;
		};

		const result = iterateHandlers(request.options);

		if (is.promise(result)) {
			if (!promise) {
				promise = asPromise(request);
			}

			if (result !== promise) {
				Object.defineProperties(result, Object.getOwnPropertyDescriptors(promise));
			}
		}

		return result;
	}) as Got;

	got.extend = (...instancesOrOptions) => {
		const optionsArray: Options[] = [defaults.options];
		let handlers: HandlerFunction[] = [...defaults.handlers!];
		let isMutableDefaults: boolean | undefined;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				optionsArray.push(value.defaults.options);
				handlers.push(...value.defaults.handlers!);
				isMutableDefaults = value.defaults.mutableDefaults;
			} else {
				optionsArray.push(value);

				if ('handlers' in value) {
					handlers.push(...value.handlers!);
				}

				isMutableDefaults = value.mutableDefaults;
			}
		}

		handlers = handlers.filter(handler => handler !== defaultHandler);

		if (handlers.length === 0) {
			handlers.push(defaultHandler);
		}

		return create({
			options: mergeOptions(...optionsArray),
			handlers,
			mutableDefaults: Boolean(isMutableDefaults)
		});
	};

	// Pagination
	const paginateEach = (async function * <T, R>(url: string | URL, options?: OptionsWithPagination<T, R>): AsyncIterableIterator<T> {
		// TODO: Remove this `@ts-expect-error` when upgrading to TypeScript 4.
		// Error: Argument of type 'Merge<Options, PaginationOptions<T, R>> | undefined' is not assignable to parameter of type 'Options | undefined'.
		// @ts-expect-error
		let normalizedOptions = normalizeArguments(url, options, defaults.options);
		normalizedOptions.resolveBodyOnly = false;

		const pagination = normalizedOptions.pagination!;

		if (!is.object(pagination)) {
			throw new TypeError('`options.pagination` must be implemented');
		}

		const allItems: T[] = [];
		let {countLimit} = pagination;

		let numberOfRequests = 0;
		while (numberOfRequests < pagination.requestLimit) {
			if (numberOfRequests !== 0) {
				// eslint-disable-next-line no-await-in-loop
				await delay(pagination.backoff);
			}

			// @ts-expect-error FIXME!
			// TODO: Throw when response is not an instance of Response
			// eslint-disable-next-line no-await-in-loop
			const response = (await got(undefined, undefined, normalizedOptions)) as Response;

			// eslint-disable-next-line no-await-in-loop
			const parsed = await pagination.transform(response);
			const currentItems: T[] = [];

			for (const item of parsed) {
				if (pagination.filter({item, currentItems, allItems})) {
					if (!pagination.shouldContinue({item, currentItems, allItems})) {
						return;
					}

					yield item as T;

					if (pagination.stackAllItems) {
						allItems.push(item as T);
					}

					currentItems.push(item as T);

					if (--countLimit <= 0) {
						return;
					}
				}
			}

			const optionsToMerge = pagination.paginate({
				response,
				currentItems,
				allItems
			});

			if (optionsToMerge === false) {
				return;
			}

			if (optionsToMerge === response.request.options) {
				normalizedOptions = response.request.options;
			} else if (optionsToMerge !== undefined) {
				normalizedOptions = normalizeArguments(undefined, optionsToMerge, normalizedOptions);
			}

			numberOfRequests++;
		}
	});

	got.paginate = paginateEach as GotPaginate;

	got.paginate.all = (async <T, R>(url: string | URL, options?: OptionsWithPagination<T, R>) => {
		const results: T[] = [];

		for await (const item of paginateEach<T, R>(url, options)) {
			results.push(item);
		}

		return results;
	}) as GotPaginate['all'];

	// For those who like very descriptive names
	got.paginate.each = paginateEach as GotPaginate['each'];

	// Stream API
	got.stream = ((url: string | URL, options?: StreamOptions) => got(url, {...options, isStream: true})) as GotStream;

	// Shortcuts
	for (const method of aliases) {
		got[method] = ((url: string | URL, options?: Options): GotReturn => got(url, {...options, method})) as GotRequestFunction;

		got.stream[method] = ((url: string | URL, options?: StreamOptions) => {
			return got(url, {...options, method, isStream: true});
		}) as GotStream;
	}

	Object.defineProperty(got, 'defaults', {
		value: defaults.mutableDefaults ? defaults : deepFreeze(defaults),
		writable: defaults.mutableDefaults,
		configurable: defaults.mutableDefaults,
		enumerable: true
	});

	return got;
};

export default create;
