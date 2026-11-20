import {setTimeout as delay} from 'node:timers/promises';
import {finished} from 'node:stream/promises';
import is, {assert} from '@sindresorhus/is';
import asPromise, {copyRequestMethods} from './as-promise/index.js';
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
	assertUrlHasSameOriginAsPrefixUrlIfNeeded,
	cloneRawOptions,
	getUrlPrefixBoundary,
	hasBodyOptionChanged,
	hasUrlOrPrefixUrlBoundaryChanged,
	isSameOrigin,
	snapshotCrossOriginState,
	type OptionsInit,
} from './core/options.js';
import type {RequestPromise} from './as-promise/types.js';

const isGotInstance = (value: Got<any> | ExtendOptions): value is Got<any> => is.function(value);

const aliases: readonly HTTPAlias[] = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete',
	'query',
];

const assertNoUrlInOptionsObject = (options: Record<string, unknown>): void => {
	if (Object.hasOwn(options, 'url')) {
		throw new TypeError('The `url` option is not supported in options objects. Pass it as the first argument instead.');
	}
};

const copyMissingProperties = (source: Promise<unknown>, target: Promise<unknown>): void => {
	const descriptors = Object.getOwnPropertyDescriptors(source);

	for (const key of Reflect.ownKeys(descriptors)) {
		// Prototype properties also count: a promise carries `then` on its prototype, and its own bookkeeping must not be replaced by another promise's state.
		if (Reflect.has(target, key)) {
			Reflect.deleteProperty(descriptors, key);
		}
	}

	void Object.defineProperties(target, descriptors);
};

const create = (defaults: InstanceDefaults): Got => {
	defaults = {
		options: new Options(undefined, undefined, defaults.options),
		handlers: [...defaults.handlers],
		mutableDefaults: defaults.mutableDefaults,
	};

	// `body`, `json` and `form` are documented as never being merged with the instance
	// defaults, so a payload given to `got.extend()` must not reach the instance's requests.
	// Only the payload is dropped: an instance may still set the body headers it wants.
	defaults.options.body = undefined;
	defaults.options.json = undefined;
	defaults.options.form = undefined;

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

		// `isStream` is intentionally skipped by `merge()`.
		// Make the flag visible to `hooks.init` for both stream call forms.
		let requestInput = url;
		let requestOptions = options;

		if (isStream) {
			if (is.plainObject(url)) {
				requestInput = Object.defineProperties({}, Object.getOwnPropertyDescriptors(url));
				Reflect.set(requestInput, 'isStream', true);
			} else if (is.plainObject(options)) {
				requestOptions = Object.defineProperties({}, Object.getOwnPropertyDescriptors(options));
				Reflect.set(requestOptions, 'isStream', true);
			}
		}

		const request = new Request(requestInput, requestOptions, defaultOptions);

		if (isStream && request.options) {
			request.options.isStream = true;
		}

		// `request.options` stays unset when the input was rejected before the options were built,
		// and the request reports that itself. Otherwise the handler must pass the instance on.
		const optionsBuilt = request.options instanceof Options;

		let operation: ReturnType<typeof asPromise> | undefined;
		const destroyRequest = () => {
			(operation?.request ?? request).destroy();
		};

		const boundaryBeforeHandlers = request.options ? getUrlPrefixBoundary(request.options) : undefined;

		const lastHandler = (normalized: Options): GotReturn => {
			// `Options` keeps its state private, so a spread copy or a plain object would lose
			// everything and then fail later with an unrelated internal error.
			if (optionsBuilt && !(normalized instanceof Options)) {
				throw new TypeError('The `next()` function of a handler must be called with the `options` object it received');
			}

			if (
				boundaryBeforeHandlers?.url
				&& normalized?.url instanceof URL
				&& hasUrlOrPrefixUrlBoundaryChanged(normalized, normalized.url, boundaryBeforeHandlers)
			) {
				assertUrlHasSameOriginAsPrefixUrlIfNeeded(normalized, normalized.url);
			}

			// Note: `options` is `undefined` when `new Options(...)` fails
			request.options = normalized;
			const shouldReturnStream = normalized?.isStream ?? isStream;
			request._noPipe = !shouldReturnStream;
			void request.flush();

			if (shouldReturnStream) {
				return request;
			}

			operation ??= asPromise(request);

			return operation.promise;
		};

		let iteration = 0;
		const iterateHandlers = (newOptions: Options): GotReturn => {
			const handler = defaults.handlers[iteration++] ?? lastHandler;

			const result = handler(newOptions, iterateHandlers) as GotReturn;

			if (is.promise(result) && !request.options?.isStream) {
				operation ??= asPromise(request);

				if (result !== operation.promise) {
					copyRequestMethods(operation.promise, result);
				}
			}

			return result;
		};

		try {
			const result = iterateHandlers(request.options);
			// Got's own promise already releases the request when it settles.
			if (is.promise(result) && result !== operation?.promise) {
				const handlerPromise = Promise.resolve(result).finally(destroyRequest);

				// Keep custom methods and Got's shortcuts on the promise that settles the handler chain.
				copyMissingProperties(result, handlerPromise);
				return handlerPromise as RequestPromise;
			}

			if (result instanceof Request && result !== request) {
				// The replacement can consume the original stream, so release it only after both sides finish. Do not consume unhandled stream errors.
				void finished(result, {error: false, cleanup: true}).catch(() => {}).finally(destroyRequest);
			}

			return result;
		} catch (error) {
			destroyRequest();
			throw error;
		}
	};

	// Got interface
	const got: Got = ((url: string | URL | OptionsInit | undefined, options?: OptionsInit, defaultOptions: Options = defaults.options): GotReturn =>
		makeRequest(url, options, defaultOptions, false)) as Got;

	got.extend = (...instancesOrOptions: Array<Got<any> | ExtendOptions>) => {
		const options = new Options(undefined, undefined, defaults.options);
		const handlers = [...defaults.handlers];

		// `instance.extend(…)` must behave like `got.extend(instance, …)`, so the parent's mutability is inherited unless an argument overrides it.
		let {mutableDefaults} = defaults;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				options.merge(value.defaults.options);
				handlers.push(...value.defaults.handlers);
				mutableDefaults = value.defaults.mutableDefaults;
			} else {
				assertNoUrlInOptionsObject(value);
				const extensionOptions: ExtendOptions = value instanceof Options ? value : cloneRawOptions(value);
				const additionalHandlers = Object.hasOwn(extensionOptions, 'handlers') ? extensionOptions.handlers : value.handlers;
				const mutableDefaultsOverride = Object.hasOwn(extensionOptions, 'mutableDefaults') ? extensionOptions.mutableDefaults : value.mutableDefaults;
				options.merge(extensionOptions);

				if (additionalHandlers) {
					// A non-function entry would otherwise be skipped or crash inside the request
					// without naming the option that caused it.
					for (const [index, handler] of additionalHandlers.entries()) {
						if (!is.function(handler)) {
							throw new TypeError(`Expected \`handlers[${index}]\` to be a function, got \`${typeof handler}\``);
						}
					}

					handlers.push(...additionalHandlers);
				}

				mutableDefaults = mutableDefaultsOverride ?? mutableDefaults;
			}
		}

		return create({
			options,
			handlers,
			mutableDefaults,
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
		// Match Request's prefix-only input normalization so later pages retain the original URL and origin.
		if (!normalizedOptions.url && normalizedOptions.prefixUrl !== '') {
			normalizedOptions.url = '';
		}

		let {pagination} = normalizedOptions;

		assert.function(pagination.transform);
		assert.function(pagination.shouldContinue);
		assert.function(pagination.filter);
		assert.function(pagination.paginate);
		assert.number(pagination.countLimit);
		assert.number(pagination.requestLimit);
		assert.number(pagination.backoff);

		const allItems: T[] = [];
		let numberOfItems = 0;

		let numberOfRequests = 0;
		while (numberOfRequests < pagination.requestLimit! && numberOfItems < pagination.countLimit!) {
			// Node turns a zero delay into a timer, so it must not throttle every page.
			if (numberOfRequests !== 0 && pagination.backoff !== 0) {
				try {
					// eslint-disable-next-line no-await-in-loop
					await delay(pagination.backoff, undefined, {signal: normalizedOptions.signal});
				} catch (error) {
					if (!normalizedOptions.signal?.aborted) {
						throw error;
					}

					// Let the next request report cancellation through Got's normal error handling.
				}
			}

			// Pagination callbacks always receive the complete response.
			normalizedOptions.resolveBodyOnly = false;
			// eslint-disable-next-line no-await-in-loop
			const response = (await got(undefined, undefined, normalizedOptions)) as Response;

			// eslint-disable-next-line no-await-in-loop
			const parsed: unknown[] = await pagination.transform!(response);

			if (!is.array(parsed)) {
				// The same context the paginate override gets, so the failing page is not anonymous.
				throw new TypeError(`Option 'pagination.transform': Expected values which are \`Array\`. Received values of type \`${typeof parsed}\`.`);
			}

			const currentItems: T[] = [];

			for (const item of parsed) {
				if (!pagination.filter!({item, currentItems, allItems})) {
					continue;
				}

				if (!pagination.shouldContinue!({item, currentItems, allItems})) {
					return;
				}

				yield item as T;

				if (pagination.stackAllItems) {
					allItems.push(item as T);
				}

				currentItems.push(item as T);

				if (++numberOfItems >= pagination.countLimit!) {
					return;
				}
			}

			if (++numberOfRequests >= pagination.requestLimit!) {
				return;
			}

			const requestOptions = response.request.options;
			const previousUrl = requestOptions.url ? new URL(requestOptions.url) : undefined;
			const previousBoundary = getUrlPrefixBoundary(requestOptions);
			const previousState = previousUrl ? snapshotCrossOriginState(requestOptions) : undefined;
			// The inner `await` applies an async `paginate`, the same way `transform` is handled.
			// eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-loop-func -- Pagination is updated only after this callback finishes.
			const [optionsToMerge, changedState] = await requestOptions.trackStateMutations(async changedState => [

				await pagination.paginate!({
					response,
					currentItems,
					allItems,
				}),
				changedState,
			] as const);

			if (optionsToMerge === false) {
				return;
			}

			// A `paginate` that forgot its return value must be reported at the option, the same
			// way `transform` is, instead of crashing later while reading `url` off it.
			if (!(optionsToMerge instanceof Options) && !is.plainObject(optionsToMerge)) {
				throw new TypeError(`Option 'pagination.paginate': Expected \`false\` or a plain options object, got \`${typeof optionsToMerge}\``);
			}

			if (optionsToMerge === requestOptions) {
				normalizedOptions = requestOptions;
				if (hasBodyOptionChanged(changedState)) {
					normalizedOptions.resetUnchangedBodyHeaders(changedState);
				}

				if (normalizedOptions.applyNextRequestMutations(previousBoundary, previousState, changedState)) {
					normalizedOptions.prefixUrl = '';
				}
			} else {
				// Validation, merging, and origin checks must see the same caller-owned values.
				const nextOptions = optionsToMerge instanceof Options ? optionsToMerge : cloneRawOptions(optionsToMerge);
				const paginationBoundary = getUrlPrefixBoundary(normalizedOptions);
				const paginationUrl = paginationBoundary.url;

				try {
					assert.any([is.string, is.urlInstance, is.undefined], nextOptions.url);
				} catch (error) {
					if (error instanceof Error) {
						error.message = `Option 'pagination.paginate.url': ${error.message}`;
					}

					throw error;
				}

				const {nextUrl, hasExplicitBody} = normalizedOptions.mergeNextRequestOptions(nextOptions, {
					previousUrl,
					previousState,
					previousBoundary: paginationBoundary,
					baseUrl: previousUrl,
				});

				if (
					previousUrl
					&& paginationUrl
					&& !isSameOrigin(paginationUrl, previousUrl)
				) {
					normalizedOptions.stripSensitiveHeaders(paginationUrl, previousUrl, nextOptions);

					if (!hasExplicitBody) {
						normalizedOptions.clearBody();
					}
				}

				if (
					nextUrl
					&& (
						normalizedOptions.prefixUrl !== paginationBoundary.prefixUrl
						|| normalizedOptions.allowAbsoluteUrls !== paginationBoundary.allowAbsoluteUrls
					)
				) {
					assertUrlHasSameOriginAsPrefixUrlIfNeeded(normalizedOptions, nextUrl);
				}
			}

			pagination = normalizedOptions.pagination;
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
		Object.freeze(defaults);
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
