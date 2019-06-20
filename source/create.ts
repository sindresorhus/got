import * as errors from './errors';
import {
	Options,
	Defaults,
	NormalizedOptions,
	Response,
	CancelableRequest,
	URLOrOptions,
	URLArgument
} from './utils/types';
import deepFreeze from './utils/deep-freeze';
import merge, {mergeOptions, mergeInstances} from './merge';
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
	extend(options?: Options): Got;
	mergeInstances(...instances: Got[]): Got;
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

	if (!defaults.handler) {
		// This can't be getPromiseOrStream, because when merging
		// the chain would stop at this point and no further handlers would be called.
		defaults.handler = (options, next) => next(options);
	}

	// @ts-ignore Because the for loop handles it for us, as well as the other Object.defines
	const got: Got = (url: URLOrOptions, options?: Options): ProxyStream | CancelableRequest<Response> => {
		try {
			return defaults.handler!(normalizeArguments(url, options as NormalizedOptions, defaults), getPromiseOrStream);
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
	got.extend = options => {
		let mutableDefaults: boolean;
		if (options && Reflect.has(options, 'mutableDefaults')) {
			mutableDefaults = options.mutableDefaults!;
			delete options.mutableDefaults;
		} else {
			mutableDefaults = defaults.mutableDefaults!;
		}

		return create({
			options: mergeOptions(defaults.options!, options!),
			handler: defaults.handler,
			mutableDefaults
		});
	};

	got.mergeInstances = (...args: Got[]) => create(mergeInstances(args));

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
