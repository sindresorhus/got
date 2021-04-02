import {URL} from 'url';
import is, {assert} from '@sindresorhus/is';
import asPromise from './as-promise';
import {
	GotReturn,
	ExtendOptions,
	Got,
	HTTPAlias,
	InstanceDefaults,
	GotPaginate,
	GotStream,
	GotRequestFunction,
	OptionsWithPagination,
	StreamOptions
} from './types';
import Request from './core/index';
import {Response} from './core/response';
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

const create = (defaults: InstanceDefaults): Got => {
	defaults = {
		options: new Options(defaults.options),
		handlers: [...defaults.handlers],
		mutableDefaults: defaults.mutableDefaults
	};

	Object.defineProperty(defaults, 'mutableDefaults', {
		enumerable: true,
		configurable: false,
		writable: false
	});

	// Got interface
	const got: Got = ((url: string | URL | OptionsInit | Options | undefined, options?: OptionsInit | Options, defaultOptions: Options = defaults.options as Options): GotReturn => {
		const request = new Request(url, options, defaultOptions);
		let promise: CancelableRequest | undefined;

		const lastHandler = (options: Options): GotReturn => {
			request.options = options;
			request._noPipe = !options?.isStream;
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
			const handler = defaults.handlers[iteration++] ?? lastHandler;

			return handler(newOptions, iterateHandlers) as GotReturn;
		};

		const result = iterateHandlers(request.options);

		if (is.promise(result)) {
			if (!promise && !request.options?.isStream) {
				promise = asPromise(request);
			}

			if (result !== promise) {
				const descriptors = Object.getOwnPropertyDescriptors(promise);

				for (const key in descriptors) {
					if (key in result) {
						delete descriptors[key];
					}
				}

				Object.defineProperties(result, descriptors);
			}
		}

		return result;
	}) as Got;

	got.extend = (...instancesOrOptions) => {
		const options = new Options(defaults.options);
		const handlers = [...defaults.handlers];

		let mutableDefaults: boolean | undefined;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				options.merge(value.defaults.options);
				handlers.push(...value.defaults.handlers);
				mutableDefaults = value.defaults.mutableDefaults;
			} else {
				options.merge(value);

				if (value.handlers) {
					handlers.push(...value.handlers);
				}

				mutableDefaults = value.mutableDefaults;
			}
		}

		return create({
			options,
			handlers,
			mutableDefaults: Boolean(mutableDefaults)
		});
	};

	// Pagination
	const paginateEach = (async function * <T, R>(url: string | URL, options?: OptionsWithPagination<T, R>): AsyncIterableIterator<T> {
		let normalizedOptions = new Options(url, options, defaults.options);
		normalizedOptions.resolveBodyOnly = false;

		const {pagination} = normalizedOptions;

		assert.function_(pagination.transform);
		assert.function_(pagination.shouldContinue);
		assert.function_(pagination.filter);
		assert.function_(pagination.paginate);
		assert.number(pagination.countLimit);
		assert.number(pagination.requestLimit);
		assert.number(pagination.backoff);

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
			} else {
				normalizedOptions.merge(optionsToMerge);
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

	if (!defaults.mutableDefaults) {
		Object.freeze(defaults.handlers);
		(defaults.options as Options).freeze();
	}

	Object.defineProperty(got, 'defaults', {
		value: defaults,
		writable: false,
		configurable: false,
		enumerable: true
	});

	return got;
};

export default create;
