import * as errors from './errors';
import {
	Options,
	Defaults,
	NormalizedOptions,
	Response,
	CancelableRequest,
	URLOrOptions,
	URLArgument,
	HandlerFunction
} from './utils/types';
import deepFreeze from './utils/deep-freeze';
import merge, {mergeOptions} from './merge';
import asPromise from './as-promise';
import asStream, {ProxyStream} from './as-stream';
import {preNormalizeArguments, normalizeArguments} from './normalize-arguments';
import {Hooks} from './known-hook-events';

const getPromiseOrStream = (options: NormalizedOptions): ProxyStream | CancelableRequest<Response> => options.stream ? asStream(options) : asPromise(options);

export type HTTPAlias = 'get' | 'post' | 'put' | 'patch' | 'head' | 'delete';

export type ReturnResponse = (url: URLArgument | Options & { stream?: false; url: URLArgument }, options?: Options & { stream?: false }) => CancelableRequest<Response>;
export type ReturnStream = (url: URLArgument | Options & { stream: true; url: URLArgument }, options?: Options & { stream: true }) => ProxyStream;

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

	(url: URLArgument | Options & { stream?: false; url: URLArgument }, options?: Options & { stream?: false }): CancelableRequest<Response>;
	(url: URLArgument | Options & { stream: true; url: URLArgument }, options?: Options & { stream: true }): ProxyStream;
	(url: URLOrOptions, options?: Options): CancelableRequest<Response> | ProxyStream;
	create(defaults: Defaults): Got;
	extend(...instancesOrOptions: Array<Got | Options & {mutableDefaults?: boolean; handlers?: HandlerFunction[]}>): Got;
	mergeOptions<T extends Options>(...sources: T[]): T & { hooks: Partial<Hooks> };
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

const create = (defaults: Partial<Defaults>): Got => {
	defaults = merge<Defaults, Partial<Defaults>>({}, defaults);
	preNormalizeArguments(defaults.options!);

	if (!defaults.handlers || defaults.handlers.length === 0) {
		defaults.handlers = [
			(options, next) => next(options)
		];
	}

	// @ts-ignore Because the for loop handles it for us, as well as the other Object.defines
	const got: Got = (url: URLOrOptions, options?: Options): ProxyStream | CancelableRequest<Response> => {
		let iteration = 0;
		const iterateHandlers = (newOptions: NormalizedOptions): ProxyStream | CancelableRequest<Response> => {
			return defaults.handlers[iteration++](newOptions, iteration === defaults.handlers.length ? getPromiseOrStream : iterateHandlers);
		};

		try {
			return iterateHandlers(normalizeArguments(url, options as NormalizedOptions, defaults));
		} catch (error) {
			if (options && options.stream) {
				throw error;
			} else {
				// @ts-ignore It's an Error not a response, but TS thinks it's calling .resolve
				return Promise.reject(error);
			}
		}
	};

	got.create = create;
	got.extend = (...instancesOrOptions) => {
		const options: Options[] = [defaults.options];
		const handlers: HandlerFunction[] = [...defaults.handlers];
		let mutableDefaults: boolean;

		for (const value of instancesOrOptions) {
			if (Reflect.has(value, 'defaults')) {
				options.push((value as Got).defaults.options);
				handlers.push(...(value as Got).defaults.handlers);

				mutableDefaults = (value as Got).defaults.mutableDefaults;
			} else {
				options.push(value as Options);

				if (Reflect.has(value, 'handlers')) {
					handlers.push(...(value as Options & {handlers?: HandlerFunction[]}).handlers);
				}

				mutableDefaults = (value as Options & {mutableDefaults?: boolean}).mutableDefaults;
			}
		}

		return create({
			options: mergeOptions(...options),
			handlers,
			mutableDefaults
		});
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
