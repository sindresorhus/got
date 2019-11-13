import * as errors from './errors';
import {
	Options,
	Defaults,
	NormalizedOptions,
	Response,
	CancelableRequest,
	URLOrOptions,
	URLArgument,
	HandlerFunction,
	DefaultOptions,
	ExtendOptions,
	NormalizedDefaults,
	DeepPartial
} from './utils/types';
import deepFreeze from './utils/deep-freeze';
import merge, {mergeOptions} from './merge';
import asPromise, {isProxiedSymbol} from './as-promise';
import asStream, {ProxyStream} from './as-stream';
import {preNormalizeArguments, normalizeArguments} from './normalize-arguments';
import {Hooks} from './known-hook-events';

export type HTTPAlias =
	| 'get'
	| 'post'
	| 'put'
	| 'patch'
	| 'head'
	| 'delete';

export type ReturnResponse = (url: URLArgument | Options & {stream?: false; url: URLArgument}, options?: Options & {stream?: false}) => CancelableRequest<Response>;
export type ReturnStream = (url: URLArgument | Options & {stream: true; url: URLArgument}, options?: Options & {stream: true}) => ProxyStream;
export type GotReturn = ProxyStream | CancelableRequest<Response>;

const getPromiseOrStream = (options: NormalizedOptions): GotReturn => options.stream ? asStream(options) : asPromise(options);

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

	(url: URLArgument | Options & {stream?: false; url: URLArgument}, options?: Options & {stream?: false}): CancelableRequest<Response>;
	(url: URLArgument | Options & {stream: true; url: URLArgument}, options?: Options & {stream: true}): ProxyStream;
	(url: URLOrOptions, options?: Options): CancelableRequest<Response> | ProxyStream;
	create(defaults: Defaults): Got;
	extend(...instancesOrOptions: Array<Got | ExtendOptions>): Got;
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

const isCancelableRequest = <T extends Response>(value: GotReturn, isStream: boolean): value is CancelableRequest<T> => (
	!isStream && !Reflect.has(value, isProxiedSymbol)
);

const isGotInstance = (value: any): value is Got => (
	Reflect.has(value, 'defaults') && Reflect.has(value.defaults, 'options')
);

// `got.mergeInstances()` is deprecated
let hasShownDeprecation = false;

const create = (nonNormalizedDefaults: Defaults): Got => {
	const defaults: NormalizedDefaults = {
		handlers: Reflect.has(nonNormalizedDefaults, 'handlers') ? merge([], nonNormalizedDefaults.handlers) : [defaultHandler],
		options: preNormalizeArguments(mergeOptions(Reflect.has(nonNormalizedDefaults, 'options') ? nonNormalizedDefaults.options : {})),
		mutableDefaults: Boolean(nonNormalizedDefaults.mutableDefaults)
	};

	// @ts-ignore Because the for loop handles it for us, as well as the other Object.defines
	const got: Got = (url: URLOrOptions, options: Options = {}): GotReturn => {
		const isStream = options?.stream ?? false;

		let iteration = 0;
		let nextPromise: CancelableRequest<Response>;
		const iterateHandlers = (newOptions: NormalizedOptions): GotReturn => {
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
			if (isCancelableRequest(result, isStream)) {
				for (const key of Object.keys(nextPromise)) {
					const promiseKey = key as keyof typeof nextPromise;
					Object.defineProperty(result, key, {
						get: () => nextPromise[promiseKey],
						set: (value: unknown) => {
							// FIXME: This will warn because there are readonly keys on nextPromise
							// @ts-ignore
							nextPromise[promiseKey] = value;
						}
					});
				}

				result.cancel = nextPromise.cancel;
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
		const options: Array<DeepPartial<DefaultOptions> & Options> = [defaults.options];
		const handlers: HandlerFunction[] = [...defaults.handlers];
		let mutableDefaults: boolean | undefined;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				options.push(value.defaults.options!);
				handlers.push(...value.defaults.handlers!.filter(handler => handler !== defaultHandler));

				mutableDefaults = value.defaults.mutableDefaults;
			} else {
				options.push(value);

				if (Reflect.has(value, 'handlers')) {
					handlers.push(...value.handlers);
				}

				mutableDefaults = value.mutableDefaults;
			}
		}

		handlers.push(defaultHandler);

		return create({
			options: mergeOptions(...options),
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
	got.stream = (url, options) => got(url, {...options, stream: true});

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
