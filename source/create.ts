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
import Options, {type OptionsInit} from './core/options.js';
import type {CancelableRequest} from './as-promise/types.js';

// The `delay` package weighs 10KB (!)
const delay = async (ms: number) => new Promise(resolve => {
	setTimeout(resolve, ms);
});

const isGotInstance = (value: Got | ExtendOptions): value is Got => is.function_(value);

const aliases: readonly HTTPAlias[] = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete',
];

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

	// Got interface
	const got: Got = ((url: string | URL | OptionsInit | undefined, options?: OptionsInit, defaultOptions: Options = defaults.options): GotReturn => {
		const request = new Request(url, options, defaultOptions);
		let promise: CancelableRequest | undefined;

		const lastHandler = (normalized: Options): GotReturn => {
			// Note: `options` is `undefined` when `new Options(...)` fails
			request.options = normalized;
			request._noPipe = !normalized.isStream;
			void request.flush();

			if (normalized.isStream) {
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

			const result = handler(newOptions, iterateHandlers) as GotReturn;

			if (is.promise(result) && !request.options.isStream) {
				if (!promise) {
					promise = asPromise(request);
				}

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

					result.cancel = promise.cancel;
				}
			}

			return result;
		};

		return iterateHandlers(request.options);
	}) as Got;

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

		got.stream[method] = ((url: string | URL, options?: StreamOptions) => got(url, {...options, method, isStream: true})) as GotStream;
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
