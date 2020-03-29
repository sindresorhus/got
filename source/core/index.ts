import {promisify} from 'util';
import {Duplex, Writable, Readable} from 'stream';
import {ReadStream} from 'fs';
import {URL, URLSearchParams} from 'url';
import {Socket} from 'net';
import {SecureContextOptions} from 'tls';
import http = require('http');
import {ClientRequest, RequestOptions, IncomingMessage, ServerResponse, request as httpRequest} from 'http';
import https = require('https');
import timer, {ClientRequestWithTimings, Timings, IncomingMessageWithTimings} from '@szmarczak/http-timer';
import decompressResponse = require('decompress-response');
import CacheableLookup from 'cacheable-lookup';
import CacheableRequest = require('cacheable-request');
// @ts-ignore Missing types
import http2wrapper = require('http2-wrapper');
import lowercaseKeys = require('lowercase-keys');
import ResponseLike = require('responselike');
import getStream = require('get-stream');
import is, {assert} from '@sindresorhus/is';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import proxyEvents from './utils/proxy-events';
import timedOut, {Delays, TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import urlToOptions from './utils/url-to-options';
import optionsToUrl, {URLOptions} from './utils/options-to-url';

type HttpRequestFunction = typeof httpRequest;
type Error = NodeJS.ErrnoException;

const kRequest = Symbol('request');
const kResponse = Symbol('response');
const kResponseSize = Symbol('responseSize');
const kDownloadedSize = Symbol('downloadedSize');
const kBodySize = Symbol('bodySize');
const kUploadedSize = Symbol('uploadedSize');
const kServerResponsesPiped = Symbol('serverResponsesPiped');
const kUnproxyEvents = Symbol('unproxyEvents');
const kIsFromCache = Symbol('isFromCache');
const kCancelTimeouts = Symbol('cancelTimeouts');
const kStartedReading = Symbol('startedReading');
export const kIsNormalizedAlready = Symbol('isNormalizedAlready');

const supportsBrotli = is.string((process.versions as any).brotli);

export interface Agents {
	http?: http.Agent;
	https?: https.Agent;
	http2?: unknown;
}

export const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface ToughCookieJar {
	getCookieString(currentUrl: string, options: {[key: string]: unknown}, cb: (err: Error | null, cookies: string) => void): void;
	getCookieString(url: string, callback: (error: Error | null, cookieHeader: string) => void): void;
	setCookie(cookieOrString: unknown, currentUrl: string, options: {[key: string]: unknown}, cb: (err: Error | null, cookie: unknown) => void): void;
	setCookie(rawCookie: string, url: string, callback: (error: Error | null, result: unknown) => void): void;
}

export interface PromiseCookieJar {
	getCookieString(url: string): Promise<string>;
	setCookie(rawCookie: string, url: string): Promise<unknown>;
}

export type Method =
	| 'GET'
	| 'POST'
	| 'PUT'
	| 'PATCH'
	| 'HEAD'
	| 'DELETE'
	| 'OPTIONS'
	| 'TRACE'
	| 'get'
	| 'post'
	| 'put'
	| 'patch'
	| 'head'
	| 'delete'
	| 'options'
	| 'trace';

type Promisable<T> = T | Promise<T>;

export type InitHook = (options: Options) => Promisable<void>;
export type BeforeRequestHook = (options: NormalizedOptions) => Promisable<void | Response | ResponseLike>;
export type BeforeRedirectHook = (options: NormalizedOptions, response: Response) => Promisable<void>;
export type BeforeErrorHook = (error: RequestError) => Promisable<RequestError>;

export interface Hooks {
	init?: InitHook[];
	beforeRequest?: BeforeRequestHook[];
	beforeRedirect?: BeforeRedirectHook[];
	beforeError?: BeforeErrorHook[];
}

export type HookEvent = 'init' | 'beforeRequest' | 'beforeRedirect' | 'beforeError';

export const knownHookEvents: HookEvent[] = ['init', 'beforeRequest', 'beforeRedirect', 'beforeError'];

type AcceptableResponse = IncomingMessage | ResponseLike;
type AcceptableRequestResult = AcceptableResponse | ClientRequest | Promise<AcceptableResponse | ClientRequest> | undefined;

export type RequestFunction = (url: URL, options: RequestOptions, callback?: (response: AcceptableResponse) => void) => AcceptableRequestResult;

export type Headers = Record<string, string | string[] | undefined>;

export interface Options extends URLOptions, SecureContextOptions {
	request?: RequestFunction;
	agent?: Agents | false;
	decompress?: boolean;
	timeout?: Delays | number;
	prefixUrl?: string | URL;
	body?: unknown;
	form?: {[key: string]: any};
	json?: {[key: string]: any};
	url?: string | URL;
	cookieJar?: PromiseCookieJar | ToughCookieJar;
	ignoreInvalidCookies?: boolean;
	encoding?: BufferEncoding;
	searchParams?: string | {[key: string]: string | number | boolean | null} | URLSearchParams;
	dnsCache?: CacheableLookup | boolean;
	context?: object;
	hooks?: Hooks;
	followRedirect?: boolean;
	maxRedirects?: number;
	cache?: string | CacheableRequest.StorageAdapter | false;
	throwHttpErrors?: boolean;
	username?: string;
	password?: string;
	http2?: boolean;
	allowGetBody?: boolean;
	lookup?: CacheableLookup['lookup'];
	rejectUnauthorized?: boolean;
	headers?: Headers;
	methodRewriting?: boolean;

	// From http.RequestOptions
	localAddress?: string;
	socketPath?: string;
	method?: string;
	createConnection?: (options: http.RequestOptions, oncreate: (error: Error, socket: Socket) => void) => Socket;
}

export interface NormalizedOptions extends Options {
	method: Method;
	url: URL;
	timeout: Delays;
	prefixUrl: string;
	ignoreInvalidCookies: boolean;
	decompress: boolean;
	searchParams?: URLSearchParams;
	cookieJar?: PromiseCookieJar;
	headers: Headers;
	context: object;
	hooks: Required<Hooks>;
	followRedirect: boolean;
	maxRedirects: number;
	cache?: string | CacheableRequest.StorageAdapter;
	throwHttpErrors: boolean;
	dnsCache?: CacheableLookup;
	cacheableRequest?: (options: string | URL | http.RequestOptions, callback?: (response: http.ServerResponse | ResponseLike) => void) => CacheableRequest.Emitter;
	http2: boolean;
	allowGetBody: boolean;
	rejectUnauthorized: boolean;
	lookup?: CacheableLookup['lookup'];
	methodRewriting: boolean;
	username: string;
	password: string;
	[kRequest]: HttpRequestFunction;
	[kIsNormalizedAlready]?: boolean;
}

export interface Defaults {
	timeout: Delays;
	prefixUrl: string;
	method: Method;
	ignoreInvalidCookies: boolean;
	decompress: boolean;
	context: object;
	cookieJar?: PromiseCookieJar | ToughCookieJar;
	dnsCache?: CacheableLookup;
	headers: Headers;
	hooks: Required<Hooks>;
	followRedirect: boolean;
	maxRedirects: number;
	cache?: string | CacheableRequest.StorageAdapter;
	throwHttpErrors: boolean;
	http2: boolean;
	allowGetBody: boolean;
	rejectUnauthorized: boolean;
	methodRewriting: boolean;

	// Optional
	agent?: Agents | false;
	request?: RequestFunction;
	searchParams?: URLSearchParams;
	lookup?: CacheableLookup['lookup'];
	localAddress?: string;
	createConnection?: Options['createConnection'];
}

export interface Progress {
	percent: number;
	transferred: number;
	total?: number;
}

export interface PlainResponse extends IncomingMessageWithTimings {
	requestUrl: string;
	redirectUrls: string[];
	request: Request;
	ip?: string;
	isFromCache: boolean;
	statusCode: number;
	url: string;
	timings: Timings;
}

// For Promise support
export interface Response<T = unknown> extends PlainResponse {
	body: T;
	retryCount: number;
}

export interface RequestEvents<T> {
	on(name: 'request', listener: (request: http.ClientRequest) => void): T;
	on<R extends Response>(name: 'response', listener: (response: R) => void): T;
	on<R extends Response, N extends NormalizedOptions>(name: 'redirect', listener: (response: R, nextOptions: N) => void): T;
	on(name: 'uploadProgress' | 'downloadProgress', listener: (progress: Progress) => void): T;
}

function validateSearchParams(searchParams: Record<string, unknown>): asserts searchParams is Record<string, string | number | boolean | null> {
	// eslint-disable-next-line guard-for-in
	for (const key in searchParams) {
		const value = searchParams[key];

		if (!is.string(value) && !is.number(value) && !is.boolean(value) && !is.null_(value)) {
			throw new TypeError(`The \`searchParams\` value '${String(value)}' must be a string, number, boolean or null`);
		}
	}
}

function isClientRequest(clientRequest: unknown): clientRequest is ClientRequest {
	return is.object(clientRequest) && !('statusCode' in clientRequest);
}

const cacheFn = async (url: URL, options: RequestOptions): Promise<ClientRequest | ResponseLike> => new Promise<ClientRequest | ResponseLike>((resolve, reject) => {
	// TODO: Remove `utils/url-to-options.ts` when `cacheable-request` is fixed
	Object.assign(options, urlToOptions(url));

	// `http-cache-semantics` checks this
	delete (options as unknown as NormalizedOptions).url;

	// TODO: `cacheable-request` is incorrectly typed
	const cacheRequest = (options as Pick<NormalizedOptions, 'cacheableRequest'>).cacheableRequest!(options, resolve as any);

	// Restore options
	(options as unknown as NormalizedOptions).url = url;

	cacheRequest.once('error', (error: Error) => {
		if (error instanceof CacheableRequest.RequestError) {
			// TODO: `options` should be `normalizedOptions`
			reject(new RequestError(error.message, error, options as unknown as NormalizedOptions));
			return;
		}

		// TODO: `options` should be `normalizedOptions`
		reject(new CacheError(error, options as unknown as NormalizedOptions));
	});
	cacheRequest.once('request', resolve);
});

const waitForOpenFile = async (file: ReadStream): Promise<void> => new Promise((resolve, reject) => {
	const onError = (error: Error): void => {
		reject(error);
	};

	file.once('error', onError);
	file.once('open', () => {
		file.off('error', onError);
		resolve();
	});
});

const redirectCodes: ReadonlySet<number> = new Set([300, 301, 302, 303, 304, 307, 308]);

type NonEnumerableProperty = 'context' | 'body' | 'json' | 'form';
const nonEnumerableProperties: NonEnumerableProperty[] = [
	'context',
	'body',
	'json',
	'form'
];

const setNonEnumerableProperties = (sources: Array<Options | Defaults | undefined>, to: Options): void => {
	// Non enumerable properties shall not be merged
	const properties: Partial<{[Key in NonEnumerableProperty]: any}> = {};

	for (const source of sources) {
		if (!source) {
			continue;
		}

		for (const name of nonEnumerableProperties) {
			if (!(name in source)) {
				continue;
			}

			properties[name] = {
				writable: true,
				configurable: true,
				enumerable: false,
				// @ts-ignore TS doesn't see the check above
				value: source[name]
			};
		}
	}

	Object.defineProperties(to, properties);
};

export class RequestError extends Error {
	code?: string;
	stack!: string;
	declare readonly options: NormalizedOptions;
	readonly response?: Response;
	readonly request?: Request;
	readonly timings?: Timings;

	constructor(message: string, error: Partial<Error & {code?: string}>, options: NormalizedOptions, requestOrResponse?: Request | Response) {
		super(message);
		Error.captureStackTrace(this, this.constructor);

		this.name = 'RequestError';
		this.code = error.code;

		Object.defineProperty(this, 'options', {
			// This fails because of TS 3.7.2 useDefineForClassFields
			// Ref: https://github.com/microsoft/TypeScript/issues/34972
			enumerable: false,
			value: options
		});

		if (requestOrResponse instanceof IncomingMessage) {
			Object.defineProperty(this, 'response', {
				enumerable: false,
				value: requestOrResponse
			});

			requestOrResponse = requestOrResponse.request;
		}

		if (requestOrResponse instanceof Request) {
			Object.defineProperty(this, 'request', {
				enumerable: false,
				value: requestOrResponse
			});

			this.timings = requestOrResponse.timings;
		}

		// Recover the original stacktrace
		if (!is.undefined(error.stack)) {
			const indexOfMessage = this.stack.indexOf(this.message) + this.message.length;
			const thisStackTrace = this.stack.slice(indexOfMessage).split('\n').reverse();
			const errorStackTrace = error.stack.slice(error.stack.indexOf(error.message!) + error.message!.length).split('\n').reverse();

			// Remove duplicated traces
			while (errorStackTrace.length !== 0 && errorStackTrace[0] === thisStackTrace[0]) {
				thisStackTrace.shift();
			}

			this.stack = `${this.stack.slice(0, indexOfMessage)}${thisStackTrace.reverse().join('\n')}${errorStackTrace.reverse().join('\n')}`;
		}
	}
}

export class MaxRedirectsError extends RequestError {
	declare readonly response: Response;

	constructor(response: Response, maxRedirects: number, options: NormalizedOptions) {
		super(`Redirected ${maxRedirects} times. Aborting.`, {}, options);
		this.name = 'MaxRedirectsError';

		Object.defineProperty(this, 'response', {
			enumerable: false,
			value: response
		});
	}
}

export class HTTPError extends RequestError {
	declare readonly response: Response;

	constructor(response: Response, options: NormalizedOptions) {
		super(`Response code ${response.statusCode} (${response.statusMessage!})`, {}, options);
		this.name = 'HTTPError';

		Object.defineProperty(this, 'response', {
			enumerable: false,
			value: response
		});
	}
}

export class CacheError extends RequestError {
	constructor(error: Error, options: NormalizedOptions) {
		super(error.message, error, options);
		this.name = 'CacheError';
	}
}

export class UploadError extends RequestError {
	constructor(error: Error, options: NormalizedOptions, request: Request) {
		super(error.message, error, options, request);
		this.name = 'UploadError';
	}
}

export class TimeoutError extends RequestError {
	readonly timings: Timings;
	readonly event: string;

	constructor(error: TimedOutTimeoutError, timings: Timings, options: NormalizedOptions) {
		super(error.message, error, options);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

export class ReadError extends RequestError {
	constructor(error: Error, options: NormalizedOptions, response: Response) {
		super(error.message, error, options, response);
		this.name = 'ReadError';
	}
}

export class UnsupportedProtocolError extends RequestError {
	constructor(options: NormalizedOptions) {
		super(`Unsupported protocol "${options.url.protocol}"`, {}, options);
		this.name = 'UnsupportedProtocolError';
	}
}

const proxiedRequestEvents = [
	'socket',
	'abort',
	'connect',
	'continue',
	'information',
	'upgrade',
	'timeout'
];

export default class Request extends Duplex implements RequestEvents<Request> {
	['constructor']: typeof Request;

	declare [kUnproxyEvents]: () => void;
	declare _cannotHaveBody: boolean;
	[kDownloadedSize]: number;
	[kUploadedSize]: number;
	[kBodySize]?: number;
	[kServerResponsesPiped]: Set<ServerResponse>;
	[kIsFromCache]?: boolean;
	[kStartedReading]?: boolean;
	[kCancelTimeouts]?: () => void;
	[kResponseSize]?: number;
	[kResponse]?: IncomingMessage;
	[kRequest]?: ClientRequest;
	_noPipe?: boolean;
	_progressCallbacks: Array<() => void>;

	declare options: NormalizedOptions;
	declare requestUrl: string;
	finalized: boolean;
	redirects: string[];

	constructor(url: string | URL, options: Options = {}, defaults?: Defaults) {
		super({
			// It needs to be zero because we're just proxying the data to another stream
			highWaterMark: 0
		});

		this[kDownloadedSize] = 0;
		this[kUploadedSize] = 0;
		this.finalized = false;
		this[kServerResponsesPiped] = new Set<ServerResponse>();
		this.redirects = [];

		// TODO: Remove this when targeting Node.js >= 12
		this._progressCallbacks = [];

		const unlockWrite = (): void => this._unlockWrite();
		const lockWrite = (): void => this._lockWrite();

		this.on('pipe', (source: Writable) => {
			source.prependListener('data', unlockWrite);
			source.on('data', lockWrite);

			source.prependListener('end', unlockWrite);
			source.on('end', lockWrite);
		});

		this.on('unpipe', (source: Writable) => {
			source.off('data', unlockWrite);
			source.off('data', lockWrite);

			source.off('end', unlockWrite);
			source.off('end', lockWrite);
		});

		this.on('pipe', source => {
			if (source instanceof IncomingMessage) {
				this.options.headers = {
					...source.headers,
					...this.options.headers
				};
			}
		});

		const {json, body, form} = options;
		if (json || body || form) {
			this._lockWrite();
		}

		(async (nonNormalizedOptions: Options) => {
			try {
				if (nonNormalizedOptions.body instanceof ReadStream) {
					await waitForOpenFile(nonNormalizedOptions.body);
				}

				if (kIsNormalizedAlready in nonNormalizedOptions) {
					this.options = nonNormalizedOptions as NormalizedOptions;
				} else {
					// @ts-ignore Common TypeScript bug saying that `this.constructor` is not accessible
					this.options = this.constructor.normalizeArguments(url, nonNormalizedOptions, defaults);
				}

				const {url: normalizedURL} = this.options;

				if (!normalizedURL) {
					throw new TypeError('Missing `url` property');
				}

				this.requestUrl = normalizedURL.toString();
				decodeURI(this.requestUrl);

				await this._finalizeBody();
				await this._makeRequest();

				this.finalized = true;
				this.emit('finalized');
			} catch (error) {
				if (error instanceof RequestError) {
					this._beforeError(error);
					return;
				}

				this.destroy(error);
			}
		})(options);
	}

	static normalizeArguments(url?: string | URL, options?: Options, defaults?: Defaults): NormalizedOptions {
		const rawOptions = options;

		if (is.object(url) && !is.urlInstance(url)) {
			options = {...defaults as NormalizedOptions, ...(url as Options), ...options};
		} else {
			if (url && options && options.url) {
				throw new TypeError('The `url` option is mutually exclusive with the `input` argument');
			}

			options = {...defaults as NormalizedOptions, ...options};

			if (url) {
				options.url = url;
			}
		}

		if (rawOptions && defaults) {
			for (const key in rawOptions) {
				// @ts-ignore Dear TypeScript, all object keys are strings (or symbols which are NOT enumerable).
				if (is.undefined(rawOptions[key]) && !is.undefined(defaults[key])) {
					// @ts-ignore See the note above
					options[key] = defaults[key];
				}
			}
		}

		// TODO: Deprecate URL options in Got 12.

		// Verify types
		if (is.null_(options.encoding)) {
			throw new TypeError('To get a Buffer, set `options.responseType` to `buffer` instead');
		}

		// Support extend-specific options
		if (options.cache === false) {
			options.cache = undefined;
		}

		// Nice type assertions
		assert.any([is.string, is.undefined], options.method);
		assert.any([is.object, is.undefined], options.headers);
		assert.any([is.string, is.urlInstance, is.undefined], options.prefixUrl);
		assert.any([is.object, is.undefined], options.cookieJar);
		assert.any([is.object, is.string, is.undefined], options.searchParams);
		assert.any([is.object, is.string, is.undefined], options.cache);
		assert.any([is.object, is.number, is.undefined], options.timeout);
		assert.any([is.object, is.undefined], options.context);
		assert.any([is.object, is.undefined], options.hooks);
		assert.any([is.boolean, is.undefined], options.decompress);
		assert.any([is.boolean, is.undefined], options.ignoreInvalidCookies);
		assert.any([is.string, is.undefined], options.encoding);
		assert.any([is.boolean, is.undefined], options.followRedirect);
		assert.any([is.number, is.undefined], options.maxRedirects);
		assert.any([is.boolean, is.undefined], options.throwHttpErrors);
		assert.any([is.boolean, is.undefined], options.http2);
		assert.any([is.boolean, is.undefined], options.allowGetBody);
		assert.any([is.boolean, is.undefined], options.rejectUnauthorized);

		// `options.method`
		if (is.string(options.method)) {
			options.method = options.method.toUpperCase();
		} else {
			options.method = 'GET';
		}

		// `options.headers`
		if (is.undefined(options.headers)) {
			options.headers = {};
		} else {
			options.headers = lowercaseKeys({...(defaults?.headers), ...options.headers});
		}

		// Disallow legacy `url.Url`
		if ('slashes' in options) {
			throw new TypeError('The legacy `url.Url` has been deprecated. Use `URL` instead.');
		}

		// `options.auth`
		if ('auth' in options) {
			throw new TypeError('Parameter `auth` is deprecated. Use `username` / `password` instead.');
		}

		// `options.prefixUrl` & `options.url`
		if (options.prefixUrl) {
			options.prefixUrl = options.prefixUrl.toString();

			if (options.prefixUrl !== '' && !options.prefixUrl.endsWith('/')) {
				options.prefixUrl += '/';
			}
		} else {
			options.prefixUrl = '';
		}

		if (is.string(options.url)) {
			if (options.url.startsWith('/')) {
				throw new Error('`input` must not start with a slash when using `prefixUrl`');
			}

			options.url = optionsToUrl(options.prefixUrl + options.url, options as Options & {searchParams?: URLSearchParams});
		} else if ((is.undefined(options.url) && options.prefixUrl !== '') || options.protocol) {
			options.url = optionsToUrl(options.prefixUrl, options as Options & {searchParams?: URLSearchParams});
		}

		if (options.url) {
			// Make it possible to change `options.prefixUrl`
			let {prefixUrl} = options;
			Object.defineProperty(options, 'prefixUrl', {
				set: (value: string) => {
					const url = options!.url as URL;

					if (!url.href.startsWith(value)) {
						throw new Error(`Cannot change \`prefixUrl\` from ${prefixUrl} to ${value}: ${url.href}`);
					}

					options!.url = new URL(value + url.href.slice(prefixUrl.length));
					prefixUrl = value;
				},
				get: () => prefixUrl
			});

			// Protocol check
			let {protocol} = options.url;

			if (protocol === 'unix:') {
				protocol = 'http:';

				options.url = new URL(`http://unix${options.url.pathname}${options.url.search}`);
			}

			if (protocol !== 'http:' && protocol !== 'https:') {
				throw new UnsupportedProtocolError(options as NormalizedOptions);
			}
		}

		// `options.username` & `options.password`
		options.username = options.username ?? '';
		options.password = options.password ?? '';

		if (options.url) {
			options.url.username = options.username;
			options.url.password = options.password;
		}

		// `options.cookieJar`
		if (options.cookieJar) {
			let {setCookie, getCookieString} = options.cookieJar;

			// Horrible `tough-cookie` check
			if (setCookie.length === 4 && getCookieString.length === 0) {
				setCookie = promisify(setCookie.bind(options.cookieJar));
				getCookieString = promisify(getCookieString.bind(options.cookieJar));
			} else if (setCookie.length !== 2) {
				throw new TypeError('`options.cookieJar.setCookie` needs to be an async function with 2 arguments');
			} else if (getCookieString.length !== 1) {
				throw new TypeError('`options.cookieJar.getCookieString` needs to be an async function with 1 argument');
			}

			options.cookieJar = {setCookie, getCookieString};
		}

		// `options.searchParams`
		if (options.searchParams) {
			if (!is.string(options.searchParams) && !(options.searchParams instanceof URLSearchParams)) {
				validateSearchParams(options.searchParams);
			}

			options.searchParams = new URLSearchParams(options.searchParams as Record<string, string>);

			// `normalizeArguments()` is also used to merge options
			const defaultsAsOptions = defaults as Options | undefined;
			if (defaultsAsOptions && defaultsAsOptions.searchParams instanceof URLSearchParams) {
				defaultsAsOptions.searchParams.forEach((value, key) => {
					(options!.searchParams as URLSearchParams).append(key, value);
				});
			}

			if (options.url) {
				options.url.search = options.searchParams.toString();
			}
		}

		// `options.cache`
		if (options.cache && !(options as NormalizedOptions).cacheableRequest) {
			// Better memory management, so we don't have to generate a new object every time
			(options as NormalizedOptions).cacheableRequest = new CacheableRequest(
				((requestOptions: RequestOptions, handler?: (response: IncomingMessage) => void): ClientRequest => (requestOptions as Pick<NormalizedOptions, typeof kRequest>)[kRequest](requestOptions, handler)) as HttpRequestFunction,
				options.cache
			);
		}

		// `options.dnsCache`
		if (options.dnsCache === true) {
			options.dnsCache = new CacheableLookup();
		} else if (!is.undefined(options.dnsCache) && options.dnsCache !== false && !(options.dnsCache instanceof CacheableLookup)) {
			throw new TypeError(`Parameter \`dnsCache\` must be a CacheableLookup instance or a boolean, got ${is(options.dnsCache)}`);
		}

		// `options.timeout`
		if (is.number(options.timeout)) {
			options.timeout = {request: options.timeout};
		} else if (defaults) {
			options.timeout = {
				...defaults.timeout,
				...options.timeout
			};
		} else {
			options.timeout = {...options.timeout};
		}

		// `options.context`
		if (!options.context) {
			options.context = {};
		}

		// `options.hooks`
		options.hooks = {...options.hooks};

		for (const event of knownHookEvents) {
			if (event in options.hooks) {
				if (is.array(options.hooks[event])) {
					// See https://github.com/microsoft/TypeScript/issues/31445#issuecomment-576929044
					(options.hooks as any)[event] = [...options.hooks[event]!];
				} else {
					throw new TypeError(`Parameter \`${event}\` must be an Array, got ${is(options.hooks[event])}`);
				}
			} else {
				options.hooks[event] = [];
			}
		}

		if (defaults) {
			for (const event of knownHookEvents) {
				const defaultHooks = defaults.hooks[event];

				if (defaultHooks.length !== 0) {
					// See https://github.com/microsoft/TypeScript/issues/31445#issuecomment-576929044
					(options.hooks as any)[event] = [
						...defaults.hooks[event],
						...options.hooks[event]!
					];
				}
			}
		}

		// Other options
		if ('followRedirects' in options) {
			throw new TypeError('The `followRedirects` option does not exist. Use `followRedirect` instead.');
		}

		if (options.agent) {
			for (const key in options.agent) {
				if (key !== 'http' && key !== 'https' && key !== 'http2') {
					throw new TypeError(`Expected the \`options.agent\` properties to be \`http\`, \`https\` or \`http2\`, got \`${key}\``);
				}
			}
		}

		options.maxRedirects = options.maxRedirects ?? 0;

		// Set non-enumerable properties
		setNonEnumerableProperties([defaults, options], options);

		return options as NormalizedOptions;
	}

	_lockWrite(): void {
		const onLockedWrite = (): never => {
			throw new TypeError('The payload has been already provided');
		};

		this.write = onLockedWrite;
		this.end = onLockedWrite;
	}

	_unlockWrite(): void {
		this.write = super.write;
		this.end = super.end;
	}

	async _finalizeBody(): Promise<void> {
		const {options} = this;
		const {headers} = options;

		const isForm = !is.undefined(options.form);
		const isJSON = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		const hasPayload = isForm || isJSON || isBody;
		const cannotHaveBody = withoutBody.has(options.method) && !(options.method === 'GET' && options.allowGetBody);

		this._cannotHaveBody = cannotHaveBody;

		if (hasPayload) {
			if (cannotHaveBody) {
				throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
			}

			if ([isBody, isForm, isJSON].filter(isTrue => isTrue).length > 1) {
				throw new TypeError('The `body`, `json` and `form` options are mutually exclusive');
			}

			if (
				isBody &&
				!(options.body instanceof Readable) &&
				!is.string(options.body) &&
				!is.buffer(options.body) &&
				!isFormData(options.body)
			) {
				throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
			}

			if (isForm && !is.object(options.form)) {
				throw new TypeError('The `form` option must be an Object');
			}

			{
				// Serialize body
				const noContentType = !is.string(headers['content-type']);

				if (isBody) {
					// Special case for https://github.com/form-data/form-data
					if (isFormData(options.body) && noContentType) {
						headers['content-type'] = `multipart/form-data; boundary=${options.body.getBoundary()}`;
					}
				} else if (isForm) {
					if (noContentType) {
						headers['content-type'] = 'application/x-www-form-urlencoded';
					}

					options.body = (new URLSearchParams(options.form as Record<string, string>)).toString();
				} else {
					if (noContentType) {
						headers['content-type'] = 'application/json';
					}

					options.body = JSON.stringify(options.json);
				}

				const uploadBodySize = await getBodySize(options);

				// See https://tools.ietf.org/html/rfc7230#section-3.3.2
				// A user agent SHOULD send a Content-Length in a request message when
				// no Transfer-Encoding is sent and the request method defines a meaning
				// for an enclosed payload body.  For example, a Content-Length header
				// field is normally sent in a POST request even when the value is 0
				// (indicating an empty payload body).  A user agent SHOULD NOT send a
				// Content-Length header field when the request message does not contain
				// a payload body and the method semantics do not anticipate such a
				// body.
				if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding'])) {
					if (!cannotHaveBody && !is.undefined(uploadBodySize)) {
						headers['content-length'] = String(uploadBodySize);
					}
				}
			}
		} else if (cannotHaveBody) {
			this._lockWrite();
		} else {
			this._unlockWrite();
		}

		this[kBodySize] = Number(headers['content-length']) || undefined;
	}

	async _onResponse(response: IncomingMessage): Promise<void> {
		const {options} = this;
		const {url} = options;

		if (options.decompress) {
			response = decompressResponse(response);
		}

		const statusCode = response.statusCode!;
		const typedResponse = response as Response;

		typedResponse.statusMessage = typedResponse.statusMessage === '' ? http.STATUS_CODES[statusCode] : typedResponse.statusMessage;
		typedResponse.url = options.url.toString();
		typedResponse.requestUrl = this.requestUrl;
		typedResponse.redirectUrls = this.redirects;
		typedResponse.request = this;
		typedResponse.isFromCache = (response as any).fromCache || false;
		typedResponse.ip = this.ip;

		this[kIsFromCache] = typedResponse.isFromCache;

		const rawCookies = response.headers['set-cookie'];
		if (is.object(options.cookieJar) && rawCookies) {
			let promises: Array<Promise<unknown>> = rawCookies.map(async (rawCookie: string) => (options.cookieJar as PromiseCookieJar).setCookie(rawCookie, url.toString()));

			if (options.ignoreInvalidCookies) {
				promises = promises.map(async p => p.catch(() => {}));
			}

			try {
				await Promise.all(promises);
			} catch (error) {
				this._beforeError(error);
				return;
			}
		}

		if (options.followRedirect && response.headers.location && redirectCodes.has(statusCode)) {
			// We're being redirected, we don't care about the response.
			// It'd be besto to abort the request, but we can't because
			// we would have to sacrifice the TCP connection. We don't want that.
			response.resume();

			if (this[kRequest]) {
				this[kCancelTimeouts]!();

				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete this[kRequest];
				this[kUnproxyEvents]();
			}

			const shouldBeGet = statusCode === 303 && options.method !== 'GET' && options.method !== 'HEAD';
			if (shouldBeGet || !options.methodRewriting) {
				// Server responded with "see other", indicating that the resource exists at another location,
				// and the client should request it from that location via GET or HEAD.
				options.method = 'GET';

				if ('body' in options) {
					delete options.body;
				}

				if ('json' in options) {
					delete options.json;
				}

				if ('form' in options) {
					delete options.form;
				}
			}

			if (this.redirects.length >= options.maxRedirects) {
				this._beforeError(new MaxRedirectsError(typedResponse, options.maxRedirects, options));
				return;
			}

			try {
				// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
				const redirectBuffer = Buffer.from(response.headers.location, 'binary').toString();
				const redirectUrl = new URL(redirectBuffer, url);
				const redirectString = redirectUrl.toString();
				decodeURI(redirectString);

				// Redirecting to a different site, clear sensitive data.
				if (redirectUrl.hostname !== url.hostname) {
					if ('cookie' in options.headers) {
						delete options.headers.cookie;
					}

					if ('authorization' in options.headers) {
						delete options.headers.authorization;
					}

					if (options.username || options.password) {
						delete options.username;
						delete options.password;
					}
				}

				this.redirects.push(redirectString);
				options.url = redirectUrl;

				for (const hook of options.hooks.beforeRedirect) {
					// eslint-disable-next-line no-await-in-loop
					await hook(options, typedResponse);
				}

				this.emit('redirect', typedResponse, options);

				await this._makeRequest();
			} catch (error) {
				this._beforeError(error);
				return;
			}

			return;
		}

		const limitStatusCode = options.followRedirect ? 299 : 399;
		const isOk = (statusCode >= 200 && statusCode <= limitStatusCode) || statusCode === 304;
		if (options.throwHttpErrors && !isOk) {
			await this._beforeError(new HTTPError(typedResponse, options));

			if (this.destroyed) {
				return;
			}
		}

		this[kResponseSize] = Number(response.headers['content-length']) || undefined;
		this[kResponse] = response;

		// We need to call `_read()` only when the Request stream is flowing
		response.on('readable', () => {
			if ((this as any).readableFlowing) {
				this._read();
			}
		});

		this.on('resume', () => {
			response.resume();
		});

		this.on('pause', () => {
			response.pause();
		});

		response.once('end', () => {
			this[kResponseSize] = this[kDownloadedSize];
			this.emit('downloadProgress', this.downloadProgress);

			this.push(null);
		});

		response.on('error', (error: Error) => {
			this._beforeError(new ReadError(error, options, response as Response));
		});

		for (const destination of this[kServerResponsesPiped]) {
			if (destination.headersSent) {
				continue;
			}

			// eslint-disable-next-line guard-for-in
			for (const key in response.headers) {
				const isAllowed = options.decompress ? key !== 'content-encoding' : true;
				const value = response.headers[key];

				if (isAllowed) {
					destination.setHeader(key, value!);
				}
			}

			destination.statusCode = statusCode;
		}

		this.emit('downloadProgress', this.downloadProgress);
		this.emit('response', response);
	}

	_onRequest(request: ClientRequest): void {
		const {options} = this;
		const {timeout, url} = options;

		timer(request);

		this[kCancelTimeouts] = timedOut(request, timeout, url);

		request.once('response', response => {
			this._onResponse(response);
		});

		request.once('error', (error: Error) => {
			if (error instanceof TimedOutTimeoutError) {
				error = new TimeoutError(error, this.timings!, options);
			} else {
				error = new RequestError(error.message, error, options, this);
			}

			this._beforeError(error as RequestError);
		});

		this[kUnproxyEvents] = proxyEvents(request, this, proxiedRequestEvents);

		this[kRequest] = request;

		this.emit('uploadProgress', this.uploadProgress);

		// Send body
		const currentRequest = this.redirects.length === 0 ? this : request;
		if (is.nodeStream(options.body)) {
			options.body.pipe(currentRequest);
			options.body.once('error', (error: NodeJS.ErrnoException) => {
				this._beforeError(new UploadError(error, options, this));
			});

			options.body.once('end', () => {
				delete options.body;
			});
		} else {
			this._unlockWrite();

			if (!is.undefined(options.body)) {
				this._writeRequest(options.body, null as unknown as string, () => {});
				currentRequest.end();

				this._lockWrite();
			} else if (this._cannotHaveBody || this._noPipe) {
				currentRequest.end();

				this._lockWrite();
			}
		}

		this.emit('request', request);
	}

	async _makeRequest(): Promise<void> {
		const {options} = this;
		const {url, headers, request, agent, timeout} = options;

		for (const key in headers) {
			if (is.undefined(headers[key])) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete headers[key];
			} else if (is.null_(headers[key])) {
				throw new TypeError(`Use \`undefined\` instead of \`null\` to delete the \`${key}\` header`);
			}
		}

		if (options.decompress && is.undefined(headers['accept-encoding'])) {
			headers['accept-encoding'] = supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate';
		}

		// Set cookies
		if (options.cookieJar) {
			const cookieString: string = await options.cookieJar.getCookieString(options.url.toString());

			if (is.nonEmptyString(cookieString)) {
				options.headers.cookie = cookieString;
			}
		}

		for (const hook of options.hooks.beforeRequest) {
			// eslint-disable-next-line no-await-in-loop
			const result = await hook(options);

			if (!is.undefined(result)) {
				// @ts-ignore Skip the type mismatch to support abstract responses
				options.request = () => result;
				break;
			}
		}

		if (options.dnsCache && !('lookup' in options)) {
			options.lookup = options.dnsCache.lookup;
		}

		// UNIX sockets
		if (url.hostname === 'unix') {
			const matches = /(?<socketPath>.+?):(?<path>.+)/.exec(`${url.pathname}${url.search}`);

			if (matches?.groups) {
				const {socketPath, path} = matches.groups;

				Object.assign(options, {
					socketPath,
					path,
					host: ''
				});
			}
		}

		const isHttps = url.protocol === 'https:';

		let fallbackFn: HttpRequestFunction;
		if (options.http2) {
			fallbackFn = http2wrapper.auto;
		} else {
			fallbackFn = isHttps ? https.request : http.request;
		}

		const realFn = options.request ?? fallbackFn;
		const fn = options.cacheableRequest ? cacheFn : realFn;

		if (agent && !options.http2) {
			(options as unknown as RequestOptions).agent = agent[isHttps ? 'https' : 'http'];
		}

		options[kRequest] = realFn as HttpRequestFunction;
		delete options.request;
		delete options.timeout;

		let requestOrResponse: ReturnType<RequestFunction>;

		try {
			requestOrResponse = await fn(url, options as unknown as RequestOptions);

			if (is.undefined(requestOrResponse)) {
				requestOrResponse = fallbackFn(url, options as unknown as RequestOptions);
			}

			// Restore options
			options.request = request;
			options.timeout = timeout;
			options.agent = agent;

			if (isClientRequest(requestOrResponse)) {
				this._onRequest(requestOrResponse);

				// Emit the response after the stream has been ended
			} else if (this.writable) {
				this.once('finish', () => {
					this._onResponse(requestOrResponse as IncomingMessage);
				});

				this._unlockWrite();
				this.end();
				this._lockWrite();
			} else {
				this._onResponse(requestOrResponse as IncomingMessage);
			}
		} catch (error) {
			if (error instanceof RequestError) {
				throw error;
			}

			throw new RequestError(error.message, error, options, this);
		}
	}

	async _beforeError(error: RequestError): Promise<void> {
		try {
			const {response} = error;
			if (response && is.undefined(response.body)) {
				response.body = await getStream.buffer(response, this.options);
			}
		} catch (_) {}

		try {
			for (const hook of this.options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}
		} catch (error_) {
			error = error_;
		}

		this.destroy(error);
	}

	_read(): void {
		if (kResponse in this) {
			let data;

			while ((data = this[kResponse]!.read()) !== null) {
				this[kDownloadedSize] += data.length;
				this[kStartedReading] = true;

				const progress = this.downloadProgress;

				if (progress.percent < 1) {
					this.emit('downloadProgress', progress);
				}

				this.push(data);
			}
		}
	}

	_write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
		const write = (): void => {
			this._writeRequest(chunk, encoding, callback);
		};

		if (this.finalized) {
			write();
		} else {
			this.once('finalized', write);
		}
	}

	_writeRequest(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
		this._progressCallbacks.push((): void => {
			this[kUploadedSize] += Buffer.byteLength(chunk, encoding as BufferEncoding);

			const progress = this.uploadProgress;

			if (progress.percent < 1) {
				this.emit('uploadProgress', progress);
			}
		});

		this[kRequest]!.write(chunk, encoding, (error?: Error | null) => {
			if (!error && this._progressCallbacks.length !== 0) {
				this._progressCallbacks.shift()!();
			}

			callback(error);
		});
	}

	_final(callback: (error?: Error | null) => void): void {
		const endRequest = (): void => {
			// FIX: Node.js 10 calls the write callback AFTER the end callback!
			while (this._progressCallbacks.length !== 0) {
				this._progressCallbacks.shift()!();
			}

			// We need to check if `this[kRequest]` is present,
			// because it isn't when we use cache.
			if (!(kRequest in this)) {
				callback();
				return;
			}

			this[kRequest]!.end((error?: Error | null) => {
				if (!error) {
					this[kBodySize] = this[kUploadedSize];

					this.emit('uploadProgress', this.uploadProgress);
					this[kRequest]!.emit('upload-complete');
				}

				callback(error);
			});
		};

		if (this.finalized) {
			endRequest();
		} else {
			this.once('finalized', endRequest);
		}
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		if (kRequest in this) {
			this[kRequest]!.abort();
		} else {
			this.once('finalized', (): void => {
				if (kRequest in this) {
					this[kRequest]!.abort();
				}
			});
		}

		if (error !== null && !is.undefined(error) && !(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this.options);
		}

		callback(error);
	}

	get ip(): string | undefined {
		return this[kRequest]?.socket.remoteAddress;
	}

	get aborted(): boolean {
		return Boolean(this[kRequest]?.aborted);
	}

	get downloadProgress(): Progress {
		let percent;
		if (this[kResponseSize]) {
			percent = this[kDownloadedSize] / this[kResponseSize]!;
		} else if (this[kResponseSize] === this[kDownloadedSize]) {
			percent = 1;
		} else {
			percent = 0;
		}

		return {
			percent,
			transferred: this[kDownloadedSize],
			total: this[kResponseSize]
		};
	}

	get uploadProgress(): Progress {
		let percent;
		if (this[kBodySize]) {
			percent = this[kUploadedSize] / this[kBodySize]!;
		} else if (this[kBodySize] === this[kUploadedSize]) {
			percent = 1;
		} else {
			percent = 0;
		}

		return {
			percent,
			transferred: this[kUploadedSize],
			total: this[kBodySize]
		};
	}

	get timings(): Timings | undefined {
		return (this[kRequest] as ClientRequestWithTimings)?.timings;
	}

	get isFromCache(): boolean | undefined {
		return this[kIsFromCache];
	}

	pipe<T extends NodeJS.WritableStream>(destination: T, options?: {end?: boolean}): T {
		if (this[kStartedReading]) {
			throw new Error('Failed to pipe. The response has been emitted already.');
		}

		if (destination instanceof ServerResponse) {
			this[kServerResponsesPiped].add(destination);
		}

		return super.pipe(destination, options);
	}

	unpipe<T extends NodeJS.WritableStream>(destination: T): this {
		if (destination instanceof ServerResponse) {
			this[kServerResponsesPiped].delete(destination);
		}

		super.unpipe(destination);

		return this;
	}
}
