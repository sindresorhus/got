import * as errors from './errors';
import {
	Options,
	Defaults,
	NormalizedOptions,
	Response,
	CancelableRequest,
	URLOrOptions,
	HandlerFunction,
	ExtendedOptions,
	NormalizedDefaults
} from './utils/types';
import deepFreeze from './utils/deep-freeze';
import merge from './merge';
import asPromise, {isProxiedSymbol} from './as-promise';
import asStream, {ProxyStream} from './as-stream';
import {normalizeArguments, mergeOptions} from './normalize-arguments';
import {Hooks} from './known-hook-events';

export type HTTPAlias =
	| 'get'
	| 'post'
	| 'put'
	| 'patch'
	| 'head'
	| 'delete';

export type ReturnResponse = (url: URLOrOptions | Options & { stream?: false }, options?: Options & { stream?: false }) => CancelableRequest<Response>;
export type ReturnStream = (url: URLOrOptions | Options & { stream: true }, options?: Options & { stream: true }) => ProxyStream;
export type GotReturn = ProxyStream | CancelableRequest<Response>;

const getPromiseOrStream = (options: NormalizedOptions): GotReturn => options.isStream ? asStream(options) : asPromise(options);

export interface Got extends Record<HTTPAlias, ReturnResponse> {
	stream: GotStream;
	defaults: Defaults | Readonly<Defaults>;
	GotError: typeof errors.GotError;
	CacheError: typeof errors.CacheError;
	RequestError: typeof errors.RequestError;
	ReadError: typeof errors.ReadError;
	ParseError: typeof errors.ParseError;
	HTTPError: typeof errors.HTTPError;
	MaxRedirectsError: typeof errors.MaxRedirectsError;
	UnsupportedProtocolError: typeof errors.UnsupportedProtocolError;
	TimeoutError: typeof errors.TimeoutError;
	CancelError: typeof errors.CancelError;

	(url: URLOrOptions | Options & {stream?: false}, options?: Options & {stream?: false}): CancelableRequest<Response>;
	(url: URLOrOptions | Options & {stream: true}, options?: Options & {stream: true}): ProxyStream;
	(url: URLOrOptions, options?: Options): CancelableRequest<Response> | ProxyStream;
	create(defaults: Defaults): Got;
	extend(...instancesOrOptions: Array<Got | ExtendedOptions>): Got;
	mergeInstances(parent: Got, ...instances: Got[]): Got;
	mergeOptions<T extends Options>(...sources: T[]): T & {hooks: Partial<Hooks>};
}

export interface GotStream extends Record<HTTPAlias, ReturnStream> {
	(url: URLOrOptions, options?: Options): ProxyStream;
}

const aliases: readonly HTTPAlias[] = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

const defaultHandler: HandlerFunction = (options, next) => next(options);

// `got.mergeInstances()` is deprecated
let hasShownDeprecation = false;

const create = (nonNormalizedDefaults: Defaults): Got => {
	const defaults: NormalizedDefaults = {
		handlers: Reflect.has(nonNormalizedDefaults, 'handlers') ? merge([], nonNormalizedDefaults.handlers) : [defaultHandler],
		options: mergeOptions(Reflect.has(nonNormalizedDefaults, 'options') ? nonNormalizedDefaults.options : {}),
		mutableDefaults: Boolean(nonNormalizedDefaults.mutableDefaults)
	};

	// @ts-ignore Because the for loop handles it for us, as well as the other Object.defines
	const got: Got = (url: URLOrOptions, options?: Options): GotReturn => {
		const isStream = options?.isStream ?? false;

		let iteration = 0;
		const iterateHandlers = (newOptions: NormalizedOptions): GotReturn => {
			let nextPromise: CancelableRequest<Response>;
			const result = defaults.handlers[iteration++](newOptions, options => {
				const fn = iteration === defaults.handlers.length ? getPromiseOrStream : iterateHandlers;

				if (isStream) {
					return fn(options);
				}

				// We need to remember the `next(options)` result.
				nextPromise = fn(options) as CancelableRequest<Response>;
				return nextPromise;
			});

			// Proxy the properties from the next handler to this one
			if (!isStream && !Reflect.has(result, isProxiedSymbol)) {
				for (const key of Object.keys(nextPromise)) {
					Object.defineProperty(result, key, {
						get: () => nextPromise[key],
						set: (value: unknown) => {
							nextPromise[key] = value;
						}
					});
				}

				(result as CancelableRequest<Response>).cancel = nextPromise.cancel;
				result[isProxiedSymbol] = true;
			}

			return result;
		};

		try {
			return iterateHandlers(normalizeArguments(url, options, defaults));
		} catch (error) {
			if (isStream) {
				throw error;
			} else {
				// @ts-ignore It's an Error not a response, but TS thinks it's calling .resolve
				return Promise.reject(error);
			}
		}
	};

	got.create = create;
	got.extend = (...instancesOrOptions) => {
		const optionsArray: Options[] = [defaults.options];
		const handlers: HandlerFunction[] = [...defaults.handlers];
		let mutableDefaults: boolean;

		for (const value of instancesOrOptions) {
			if (Reflect.has(value, 'defaults')) {
				optionsArray.push((value as Got).defaults.options);
				handlers.push(...(value as Got).defaults.handlers.filter(handler => handler !== defaultHandler));

				mutableDefaults = (value as Got).defaults.mutableDefaults;
			} else {
				optionsArray.push(value as Options);

				if (Reflect.has(value, 'handlers')) {
					handlers.push(...(value as ExtendedOptions).handlers);
				}

				mutableDefaults = (value as ExtendedOptions).mutableDefaults;
			}
		}

		handlers.push(defaultHandler);

		return create({
			options: mergeOptions(...optionsArray),
			handlers,
			mutableDefaults
		});
	};

	got.mergeInstances = (parent, ...instances) => {
		if (!hasShownDeprecation) {
			console.warn('`got.mergeInstances()` is deprecated. We support it solely for compatibility - it will be removed in Got 11. Use `instance.extend(...instances)` instead.');
			hasShownDeprecation = true;
		}

		return parent.extend(...instances);
	};

	// @ts-ignore The missing methods because the for-loop handles it for us
	got.stream = (url, options) => got(url, {...options, isStream: true});

	for (const method of aliases) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, {...errors, mergeOptions});
	Object.defineProperty(got, 'defaults', {
		value: defaults.mutableDefaults ? defaults : deepFreeze(defaults),
		writable: defaults.mutableDefaults,
		configurable: defaults.mutableDefaults,
		enumerable: true
	});

	return got;
};

export default create;
