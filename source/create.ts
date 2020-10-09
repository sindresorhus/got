import {URL} from 'url';
import is from '@sindresorhus/is';
import asPromise, {
	// Response
	Response,

	// Options
	Options,
	NormalizedOptions,

	// Hooks
	InitHook,

	// Errors
	ParseError,
	RequestError,
	CacheError,
	ReadError,
	HTTPError,
	MaxRedirectsError,
	TimeoutError,
	UnsupportedProtocolError,
	UploadError,
	CancelError
} from './as-promise';
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
import createRejection from './as-promise/create-rejection';
import Request, {kIsNormalizedAlready, setNonEnumerableProperties, Defaults} from './core';
import deepFreeze from './utils/deep-freeze';

const errors = {
	RequestError,
	CacheError,
	ReadError,
	HTTPError,
	MaxRedirectsError,
	TimeoutError,
	ParseError,
	CancelError,
	UnsupportedProtocolError,
	UploadError
};

// The `delay` package weighs 10KB (!)
const delay = async (ms: number) => new Promise(resolve => {
	setTimeout(resolve, ms);
});

const {normalizeArguments} = Request;

const mergeOptions = (...sources: Options[]): NormalizedOptions => {
	let mergedOptions: NormalizedOptions | undefined;

	for (const source of sources) {
		mergedOptions = normalizeArguments(undefined, source, mergedOptions);
	}

	return mergedOptions!;
};

const getPromiseOrStream = (options: NormalizedOptions): GotReturn => options.isStream ? new Request(undefined, options) : asPromise(options);

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

const callInitHooks = (hooks: InitHook[] | undefined, options?: Options): void => {
	if (hooks) {
		for (const hook of hooks) {
			hook(options!);
		}
	}
};

const create = (defaults: InstanceDefaults): Got => {
	// Proxy properties from next handlers
	defaults._rawHandlers = defaults.handlers;
	defaults.handlers = defaults.handlers.map(fn => ((options, next) => {
		// This will be assigned by assigning result
		let root!: ReturnType<typeof next>;

		const result = fn(options, newOptions => {
			root = next(newOptions);
			return root;
		});

		if (result !== root && !options.isStream && root) {
			const typedResult = result as Promise<unknown>;

			const {then: promiseThen, catch: promiseCatch, finally: promiseFianlly} = typedResult;
			Object.setPrototypeOf(typedResult, Object.getPrototypeOf(root));
			Object.defineProperties(typedResult, Object.getOwnPropertyDescriptors(root));

			// These should point to the new promise
			// eslint-disable-next-line promise/prefer-await-to-then
			typedResult.then = promiseThen;
			typedResult.catch = promiseCatch;
			typedResult.finally = promiseFianlly;
		}

		return result;
	}));

	// Got interface
	const got: Got = ((url: string | URL, options: Options = {}, _defaults?: Defaults): GotReturn => {
		let iteration = 0;
		const iterateHandlers = (newOptions: NormalizedOptions): GotReturn => {
			return defaults.handlers[iteration++](
				newOptions,
				iteration === defaults.handlers.length ? getPromiseOrStream : iterateHandlers
			) as GotReturn;
		};

		// TODO: Remove this in Got 12.
		if (is.plainObject(url)) {
			const mergedOptions = {
				...url as Options,
				...options
			};

			setNonEnumerableProperties([url as Options, options], mergedOptions);

			options = mergedOptions;
			url = undefined as any;
		}

		try {
			// Call `init` hooks
			let initHookError: Error | undefined;
			try {
				callInitHooks(defaults.options.hooks.init, options);
				callInitHooks(options.hooks?.init, options);
			} catch (error) {
				initHookError = error;
			}

			// Normalize options & call handlers
			const normalizedOptions = normalizeArguments(url, options, _defaults ?? defaults.options);
			normalizedOptions[kIsNormalizedAlready] = true;

			if (initHookError) {
				throw new RequestError(initHookError.message, initHookError, normalizedOptions);
			}

			return iterateHandlers(normalizedOptions);
		} catch (error) {
			if (options.isStream) {
				throw error;
			} else {
				return createRejection(error, defaults.options.hooks.beforeError, options.hooks?.beforeError);
			}
		}
	}) as Got;

	got.extend = (...instancesOrOptions) => {
		const optionsArray: Options[] = [defaults.options];
		let handlers: HandlerFunction[] = [...defaults._rawHandlers!];
		let isMutableDefaults: boolean | undefined;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				optionsArray.push(value.defaults.options);
				handlers.push(...value.defaults._rawHandlers!);
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

		const all: T[] = [];
		let {countLimit} = pagination;

		let numberOfRequests = 0;
		while (numberOfRequests < pagination.requestLimit) {
			if (numberOfRequests !== 0) {
				// eslint-disable-next-line no-await-in-loop
				await delay(pagination.backoff);
			}

			// @ts-expect-error FIXME!
			// TODO: Throw when result is not an instance of Response
			// eslint-disable-next-line no-await-in-loop
			const result = (await got(undefined, undefined, normalizedOptions)) as Response;

			// eslint-disable-next-line no-await-in-loop
			const parsed = await pagination.transform(result);
			const current: T[] = [];

			for (const item of parsed) {
				if (pagination.filter(item, all, current)) {
					if (!pagination.shouldContinue(item, all, current)) {
						return;
					}

					yield item as T;

					if (pagination.stackAllItems) {
						all.push(item as T);
					}

					current.push(item as T);

					if (--countLimit <= 0) {
						return;
					}
				}
			}

			const optionsToMerge = pagination.paginate(result, all, current);

			if (optionsToMerge === false) {
				return;
			}

			if (optionsToMerge === result.request.options) {
				normalizedOptions = result.request.options;
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

	Object.assign(got, errors);
	Object.defineProperty(got, 'defaults', {
		value: defaults.mutableDefaults ? defaults : deepFreeze(defaults),
		writable: defaults.mutableDefaults,
		configurable: defaults.mutableDefaults,
		enumerable: true
	});

	got.mergeOptions = mergeOptions;

	return got;
};

export default create;
export * from './types';
