import {Merge} from 'type-fest';
import asPromise from './as-promise';
import asStream, {ProxyStream} from './as-stream';
import * as errors from './errors';
import {normalizeArguments, mergeOptions} from './normalize-arguments';
import deepFreeze from './utils/deep-freeze';
import {
	CancelableRequest,
	Defaults,
	DefaultOptions,
	ExtendOptions,
	HandlerFunction,
	NormalizedOptions,
	Options,
	Response,
	URLOrOptions
} from './utils/types';

export type HTTPAlias =
	| 'get'
	| 'post'
	| 'put'
	| 'patch'
	| 'head'
	| 'delete';

export type ReturnStream = <T>(url: string | Merge<Options, {isStream?: true}>, options?: Merge<Options, {isStream?: true}>) => ProxyStream<T>;
export type GotReturn<T = unknown> = CancelableRequest<T> | ProxyStream<T>;

const getPromiseOrStream = (options: NormalizedOptions): GotReturn => options.isStream ? asStream(options) : asPromise(options);

const isGotInstance = (value: Got | ExtendOptions): value is Got => (
	Reflect.has(value, 'defaults') && Reflect.has(value.defaults, 'options')
);

export type OptionsOfDefaultResponseBody = Merge<Options, {isStream?: false; resolveBodyOnly?: false; responseType?: 'default'}>;
type OptionsOfTextResponseBody = Merge<Options, {isStream?: false; resolveBodyOnly?: false; responseType: 'text'}>;
type OptionsOfJSONResponseBody = Merge<Options, {isStream?: false; resolveBodyOnly?: false; responseType: 'json'}>;
type OptionsOfBufferResponseBody = Merge<Options, {isStream?: false; resolveBodyOnly?: false; responseType: 'buffer'}>;
type ResponseBodyOnly = {resolveBodyOnly: true};

interface GotFunctions {
	// `asPromise` usage
	<T = string>(url: string | OptionsOfDefaultResponseBody, options?: OptionsOfDefaultResponseBody): CancelableRequest<Response<T>>;
	(url: string | OptionsOfTextResponseBody, options?: OptionsOfTextResponseBody): CancelableRequest<Response<string>>;
	<T>(url: string | OptionsOfJSONResponseBody, options?: OptionsOfJSONResponseBody): CancelableRequest<Response<T>>;
	(url: string | OptionsOfBufferResponseBody, options?: OptionsOfBufferResponseBody): CancelableRequest<Response<Buffer>>;
	// `resolveBodyOnly` usage
	<T = string>(url: string | Merge<OptionsOfDefaultResponseBody, ResponseBodyOnly>, options?: Merge<OptionsOfDefaultResponseBody, ResponseBodyOnly>): CancelableRequest<T>;
	(url: string | Merge<OptionsOfTextResponseBody, ResponseBodyOnly>, options?: Merge<OptionsOfTextResponseBody, ResponseBodyOnly>): CancelableRequest<string>;
	<T>(url: string | Merge<OptionsOfJSONResponseBody, ResponseBodyOnly>, options?: Merge<OptionsOfJSONResponseBody, ResponseBodyOnly>): CancelableRequest<T>;
	(url: string | Merge<OptionsOfBufferResponseBody, ResponseBodyOnly>, options?: Merge<OptionsOfBufferResponseBody, ResponseBodyOnly>): CancelableRequest<Buffer>;
	// `asStream` usage
	<T>(url: string | Merge<Options, {isStream: true}>, options?: Merge<Options, {isStream: true}>): ProxyStream<T>;
}

export interface Got extends Record<HTTPAlias, GotFunctions>, GotFunctions {
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

	extend(...instancesOrOptions: Array<Got | ExtendOptions>): Got;
	mergeInstances(parent: Got, ...instances: Got[]): Got;
	mergeOptions(...sources: Options[]): NormalizedOptions;
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

export const defaultHandler: HandlerFunction = (options, next) => next(options);

const create = (defaults: Defaults): Got => {
	// Proxy properties from next handlers
	// @ts-ignore Internal use only.
	defaults._rawHandlers = defaults.handlers;
	defaults.handlers = defaults.handlers.map(fn => ((options, next) => {
		// This will be assigned by assigning result
		let root!: ReturnType<typeof next>;

		const result = fn(options, newOptions => {
			root = next(newOptions);
			return root;
		});

		if (result !== root && !options.isStream) {
			Object.setPrototypeOf(result, Object.getPrototypeOf(root));
			Object.defineProperties(result, Object.getOwnPropertyDescriptors(root));
		}

		return result;
	}));

	// @ts-ignore Because the for loop handles it for us, as well as the other Object.defines
	const got: Got = (url: URLOrOptions, options?: Options): GotReturn => {
		let iteration = 0;
		const iterateHandlers = (newOptions: NormalizedOptions): GotReturn => {
			return defaults.handlers[iteration++](
				newOptions,
				// @ts-ignore TS doesn't know that it calls `getPromiseOrStream` at the end
				iteration === defaults.handlers.length ? getPromiseOrStream : iterateHandlers
			) as GotReturn;
		};

		/* eslint-disable @typescript-eslint/return-await */
		try {
			return iterateHandlers(normalizeArguments(url, options, defaults));
		} catch (error) {
			if (options?.isStream) {
				throw error;
			} else {
				// @ts-ignore It's an Error not a response, but TS thinks it's calling .resolve
				return Promise.reject(error);
			}
		}
		/* eslint-enable @typescript-eslint/return-await */
	};

	got.extend = (...instancesOrOptions) => {
		const optionsArray: Options[] = [defaults.options];
		// @ts-ignore Internal use only.
		let handlers: HandlerFunction[] = [...defaults._rawHandlers];
		let mutableDefaults: boolean | undefined;

		for (const value of instancesOrOptions) {
			if (isGotInstance(value)) {
				optionsArray.push(value.defaults.options);
				// @ts-ignore Internal use only.
				handlers.push(...value.defaults._rawHandlers);
				mutableDefaults = value.defaults.mutableDefaults;
			} else {
				optionsArray.push(value);

				if (Reflect.has(value, 'handlers')) {
					handlers.push(...value.handlers);
				}

				mutableDefaults = value.mutableDefaults;
			}
		}

		handlers = handlers.filter(handler => handler !== defaultHandler);

		if (handlers.length === 0) {
			handlers.push(defaultHandler);
		}

		return create({
			options: mergeOptions(...optionsArray) as DefaultOptions,
			handlers,
			mutableDefaults: Boolean(mutableDefaults)
		});
	};

	// @ts-ignore The missing methods because the for-loop handles it for us
	got.stream = (url, options) => got(url, {...options, isStream: true});

	for (const method of aliases) {
		// @ts-ignore GotReturn<Response> does not equal GotReturn<T>
		got[method] = (url: URLOrOptions, options?: Options): GotReturn => got(url, {...options, method});
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
