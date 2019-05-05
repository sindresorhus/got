import {Readable as ReadableStream} from 'stream';
import * as errors from './errors';
import {Options, Defaults, Method, NormalizedOptions, Response, CancelableRequest} from './utils/types';
import deepFreeze from './utils/deep-freeze';
import merge, {mergeOptions, mergeInstances} from './merge';
import asPromise from './as-promise';
import asStream, {ProxyStream} from './as-stream';
import {preNormalizeArguments, normalizeArguments} from './normalize-arguments';

const getPromiseOrStream = (options: NormalizedOptions): ProxyStream | CancelableRequest<Response> => options.stream ? asStream(options) : asPromise(options);

export type HTTPAliases = 'get' | 'post' | 'put' | 'patch' | 'head' | 'delete';

export interface Got extends Record<HTTPAliases, (url: URL | string, options?: Partial<Options>) => ProxyStream | CancelableRequest<Response>> {
	stream: GotStream;
	defaults: Defaults | Readonly<Defaults>;
	GotError: errors.GotError;
	CacheError: errors.CacheError;
	RequestError: errors.RequestError;
	ReadError: errors.ReadError;
	ParseError: errors.ParseError;
	HTTPError: errors.HTTPError;
	MaxRedirectsError: errors.MaxRedirectsError;
	UnsupportedProtocolError: errors.UnsupportedProtocolError;
	TimeoutError: errors.TimeoutError;
	CancelError: errors.CancelError;

	(url: URL | string, options: NormalizedOptions): ProxyStream | CancelableRequest<Response>;
	create(defaults: Partial<Defaults>): Got;
	extend(options?: Partial<Options>): Got;
	mergeInstances(...instances: Got[]): Got;
}

export interface GotStream extends Record<HTTPAliases, (url: URL | string, options?: Partial<Options>) => ProxyStream> {
	(url: URL | string, options?: Partial<Options>): ProxyStream;
}

const aliases: ReadonlyArray<HTTPAliases> = [
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
	const got: Got = (url, options): ProxyStream | CancelableRequest<Response> => {
		try {
			return defaults.handler!(normalizeArguments(url, options, defaults), getPromiseOrStream);
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
		let mutableDefaults;
		if (options && Reflect.has(options, 'mutableDefaults')) {
			mutableDefaults = options.mutableDefaults;
			delete options.mutableDefaults;
		} else {
			mutableDefaults = defaults.mutableDefaults;
		}

		return create({
			options: mergeOptions(defaults.options!, options!),
			handler: defaults.handler,
			mutableDefaults
		});
	};

	got.mergeInstances = (...args) => create(mergeInstances(args));

	// @ts-ignore Because the for loop handles it for us
	got.stream = (url, options) => got(url, {...options, stream: true}) as ReadableStream;

	for (const method of aliases) {
		got[method] = (url, options) => got(url, {...options, method: method as Method} as NormalizedOptions);
		got.stream[method] = (url, options) => got.stream(url, {...options, method: method as Method});
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
