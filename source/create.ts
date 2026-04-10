import {setTimeout as delay} from 'node:timers/promises';
import is, {assert} from '@sindresorhus/is';
import asPromise from './as-promise/index.js';
import type {
	GotReturn,
	ExtendOptions,
	Got,
	HTTPAlias,
	InstanceDefaults,
	GotPaginate,
	GotStream,
	GotRequestFunction,
	OptionsWithPagination,
	StreamOptions,
} from './types.js';
import Request from './core/index.js';
import type {Response} from './core/response.js';
import Options, {
	applyUrlOverride,
	isSameOrigin,
	snapshotCrossOriginState,
	type OptionsInit,
} from './core/options.js';
import type {RequestPromise} from './as-promise/types.js';

const isGotInstance = (value: Got | ExtendOptions): value is Got => is.function(value);

const aliases: readonly HTTPAlias[] = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete',
];

const optionsObjectUrlErrorMessage = 'The `url` option is not supported in options objects. Pass it as the first argument instead.';

const assertNoUrlInOptionsObject = (options: Record<string, unknown>): void => {
	if (Object.hasOwn(options, 'url')) {
		throw new TypeError(optionsObjectUrlErrorMessage);
	}
};

const cloneWithProperty = <Value extends Record<string, unknown>>(value: Value, property: string, propertyValue: unknown): Value => {
	const clone = Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value)) as Value;

	Object.defineProperty(clone, property, {
		value: propertyValue,
		enumerable: true,
		configurable: true,
		writable: true,
	});

	return clone;
};

const create = (defaults: InstanceDefaults): Got => {
	defaults = {
		options: new Options(undefined, undefined, defaults.options),
		handlers: [...defaults.handlers],
		mutableDefaults: defaults.mutableDefaults,
	};

	Object.defineProperty(defaults, 'mutableDefaults', {
		enumerable: true,
		configurable: false,
		writable: false,
	});

	const makeRequest = (url: string | URL | OptionsInit | undefined, options: OptionsInit | undefined, defaultOptions: Options, isStream: boolean): GotReturn => {
		if (is.plainObject(url)) {
			assertNoUrlInOptionsObject(url);
		}

		if (is.plainObject(options)) {
			assertNoUrlInOptionsObject(options);
		}

		// `isStream` is skipped by `merge()`, so set it via the direct setter after construction.
		// Avoid a synthetic second merge only for the single-options-object stream form.
		const requestUrl = isStream && is.plainObject(url) ? cloneWithProperty(url, 'isStream', true) : url;
		const requestOptions = isStream && !is.plainObject(url) && options ? cloneWithProperty(options, 'isStream', true) : options;

		const request = new Request(requestUrl, requestOptions, defaultOptions);

		if (isStream && request.options) {
			request.options.isStream = true;
		}

		let promise: RequestPromise | undefined;

		const lastHandler = (normalized: Options): GotReturn => {
			// Note: `options` is `undefined` when `new Options(...)` fails
			request.options = normalized;
			const shouldReturnStream = normalized?.isStream ?? isStream;
			request._noPipe = !shouldReturnStream;
			void request.flush();

			if (shouldReturnStream) {
				return request;
			}

			promise ??= asPromise(request);

			return promise;
		};

		let iteration = 0;
		const iterateHandlers = (newOptions: Options): GotReturn => {
			const handler = defaults.handlers[iteration++] ?? lastHandler;

			const result = handler(newOptions, iterateHandlers) as GotReturn;

			if (is.promise(result) && !request.options?.isStream) {
				promise ??= asPromise(request);

				if (result !== promise) {
					const descriptors = Object.getOwnPropertyDescriptors(promise);

					for (const key in descriptors) {
						if (key in result) {
							// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
							delete descriptors[key];
						}
					}

					// eslint-disable-next-line @typescript-eslint/no-floating-promises
					Object.defineProperties(result, descriptors);
				}
			}

			return result;
		};

		return iterateHandlers(request.options);
	};

	// Got interface
	const got: Got = ((url: string | URL | OptionsInit | undefined, options?: OptionsInit, defaultOptions: Options = defaults.options): GotReturn =>
		makeRequest(url, options, defaultOptions, false)) as Got;

	got.extend = (...instancesOrOptions) => {
		const options = new Options(undefined, undefined, defaults.options);
		const handlers = [...defaults.handlers];

		let mutableDefaults: boolean | undefined;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				options.merge(value.defaults.options);
				handlers.push(...value.defaults.handlers);
				mutableDefaults = value.defaults.mutableDefaults;
			} else {
				assertNoUrlInOptionsObject(value);
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
			mutableDefaults: Boolean(mutableDefaults),
		});
	};

	// Pagination
	const paginateEach = (async function * <T, R>(url: string | URL, options?: OptionsWithPagination<T, R>): AsyncIterableIterator<T> {
		if (is.plainObject(url)) {
			assertNoUrlInOptionsObject(url);
		}

		if (is.plainObject(options)) {
			assertNoUrlInOptionsObject(options);
		}

		let normalizedOptions = new Options(url, options as OptionsInit, defaults.options);
		normalizedOptions.resolveBodyOnly = false;

		const {pagination} = normalizedOptions;

		assert.function(pagination.transform);
		assert.function(pagination.shouldContinue);
		assert.function(pagination.filter);
		assert.function(pagination.paginate);
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

			// eslint-disable-next-line no-await-in-loop
			const response = (await got(undefined, undefined, normalizedOptions)) as Response;

			// eslint-disable-next-line no-await-in-loop
			const parsed: unknown[] = await pagination.transform(response);
			const currentItems: T[] = [];

			assert.array(parsed);

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

			const requestOptions = response.request.options;
			const previousUrl = requestOptions.url ? new URL(requestOptions.url) : undefined;
			const previousState = previousUrl ? snapshotCrossOriginState(requestOptions) : undefined;
			// eslint-disable-next-line no-await-in-loop
			const [optionsToMerge, changedState] = await requestOptions.trackStateMutations(async changedState => [
				pagination.paginate!({
					response,
					currentItems,
					allItems,
				}),
				changedState,
			] as const);

			if (optionsToMerge === false) {
				return;
			}

			if (optionsToMerge === response.request.options) {
				normalizedOptions = response.request.options;
				normalizedOptions.clearUnchangedCookieHeader(previousState, changedState);

				if (previousUrl) {
					const nextUrl = normalizedOptions.url as URL | undefined;
					if (nextUrl && !isSameOrigin(previousUrl, nextUrl)) {
						normalizedOptions.prefixUrl = '';
						normalizedOptions.stripUnchangedCrossOriginState(previousState!, changedState);
					}
				}
			} else {
				const hasExplicitBody = (Object.hasOwn(optionsToMerge, 'body') && optionsToMerge.body !== undefined)
					|| (Object.hasOwn(optionsToMerge, 'json') && optionsToMerge.json !== undefined)
					|| (Object.hasOwn(optionsToMerge, 'form') && optionsToMerge.form !== undefined);
				const clearsCookieJar = Object.hasOwn(optionsToMerge, 'cookieJar') && optionsToMerge.cookieJar === undefined;

				if (hasExplicitBody) {
					normalizedOptions.clearBody();
				}

				if (clearsCookieJar) {
					normalizedOptions.cookieJar = undefined;
				}

				normalizedOptions.merge(optionsToMerge);
				normalizedOptions.syncCookieHeaderAfterMerge(previousState, optionsToMerge.headers);

				try {
					assert.any([is.string, is.urlInstance, is.undefined], optionsToMerge.url);
				} catch (error) {
					if (error instanceof Error) {
						error.message = `Option 'pagination.paginate.url': ${error.message}`;
					}

					throw error;
				}

				if (optionsToMerge.url !== undefined) {
					const nextUrl = applyUrlOverride(normalizedOptions, optionsToMerge.url, optionsToMerge);

					if (previousUrl) {
						normalizedOptions.stripSensitiveHeaders(previousUrl, nextUrl, optionsToMerge);

						if (!isSameOrigin(previousUrl, nextUrl) && !hasExplicitBody) {
							normalizedOptions.clearBody();
						}
					}
				}
			}

			numberOfRequests++;
		}
	});

	got.paginate = paginateEach as GotPaginate;

	got.paginate.all = (async <T, R>(url: string | URL, options?: OptionsWithPagination<T, R>) => Array.fromAsync(paginateEach<T, R>(url, options))) as GotPaginate['all'];

	// For those who like very descriptive names
	got.paginate.each = paginateEach as GotPaginate['each'];

	// Stream API
	got.stream = ((url: string | URL, options?: StreamOptions) =>
		makeRequest(url, options, defaults.options, true)) as GotStream;

	// Shortcuts
	for (const method of aliases) {
		got[method] = ((url: string | URL, options?: Options): GotReturn => got(url, {...options, method})) as GotRequestFunction;

		got.stream[method] = ((url: string | URL, options?: StreamOptions) =>
			makeRequest(url, {...options, method}, defaults.options, true)) as GotStream;
	}

	if (!defaults.mutableDefaults) {
		Object.freeze(defaults.handlers);
		defaults.options.freeze();
	}

	Object.defineProperty(got, 'defaults', {
		value: defaults,
		writable: false,
		configurable: false,
		enumerable: true,
	});

	return got;
};

export default create;
