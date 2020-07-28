import {promisify} from 'util';
import {Duplex, Writable, Readable} from 'stream';
import {ReadStream} from 'fs';
import {URL, URLSearchParams} from 'url';
import {Socket} from 'net';
import {SecureContextOptions, DetailedPeerCertificate} from 'tls';
import http = require('http');
import {ClientRequest, RequestOptions, IncomingMessage, ServerResponse, request as httpRequest} from 'http';
import https = require('https');
import timer, {ClientRequestWithTimings, Timings, IncomingMessageWithTimings} from '@szmarczak/http-timer';
import CacheableLookup from 'cacheable-lookup';
import CacheableRequest = require('cacheable-request');
import decompressResponse = require('decompress-response');
// @ts-expect-error Missing types
import http2wrapper = require('http2-wrapper');
import lowercaseKeys = require('lowercase-keys');
import ResponseLike = require('responselike');
import is, {assert} from '@sindresorhus/is';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import proxyEvents from './utils/proxy-events';
import timedOut, {Delays, TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import urlToOptions from './utils/url-to-options';
import optionsToUrl, {URLOptions} from './utils/options-to-url';
import WeakableMap from './utils/weakable-map';
import getBuffer from './utils/get-buffer';
import {DnsLookupIpVersion, isDnsLookupIpVersion, dnsLookupIpVersionToFamily} from './utils/dns-ip-version';
import deprecationWarning from '../utils/deprecation-warning';
import {PromiseOnly} from '../as-promise/types';

const globalDnsCache = new CacheableLookup();

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
const kStopReading = Symbol('stopReading');
const kTriggerRead = Symbol('triggerRead');
const kBody = Symbol('body');
const kJobs = Symbol('jobs');
const kOriginalResponse = Symbol('originalResponse');
export const kIsNormalizedAlready = Symbol('isNormalizedAlready');

const supportsBrotli = is.string((process.versions as any).brotli);

export interface Agents {
	http?: http.Agent;
	https?: https.Agent;
	http2?: unknown;
}

export const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface ToughCookieJar {
	getCookieString: ((currentUrl: string, options: {[key: string]: unknown}, cb: (err: Error | null, cookies: string) => void) => void)
	& ((url: string, callback: (error: Error | null, cookieHeader: string) => void) => void);
	setCookie: ((cookieOrString: unknown, currentUrl: string, options: {[key: string]: unknown}, cb: (err: Error | null, cookie: unknown) => void) => void)
	& ((rawCookie: string, url: string, callback: (error: Error | null, result: unknown) => void) => void);
}

export interface PromiseCookieJar {
	getCookieString: (url: string) => Promise<string>;
	setCookie: (rawCookie: string, url: string) => Promise<unknown>;
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

export type InitHook = (options: Options) => void;
export type BeforeRequestHook = (options: NormalizedOptions) => Promisable<void | Response | ResponseLike>;
export type BeforeRedirectHook = (options: NormalizedOptions, response: Response) => Promisable<void>;
export type BeforeErrorHook = (error: RequestError) => Promisable<RequestError>;

interface PlainHooks {
	init?: InitHook[];
	beforeRequest?: BeforeRequestHook[];
	beforeRedirect?: BeforeRedirectHook[];
	beforeError?: BeforeErrorHook[];
}

export interface Hooks extends PromiseOnly.Hooks, PlainHooks {}

type PlainHookEvent = 'init' | 'beforeRequest' | 'beforeRedirect' | 'beforeError';
export type HookEvent = PromiseOnly.HookEvent | PlainHookEvent;

export const knownHookEvents: HookEvent[] = ['init', 'beforeRequest', 'beforeRedirect', 'beforeError'];

type AcceptableResponse = IncomingMessageWithTimings | ResponseLike;
type AcceptableRequestResult = AcceptableResponse | ClientRequest | Promise<AcceptableResponse | ClientRequest> | undefined;

export type RequestFunction = (url: URL, options: RequestOptions, callback?: (response: AcceptableResponse) => void) => AcceptableRequestResult;

export type Headers = Record<string, string | string[] | undefined>;

type CacheableRequestFunction = (
	opts: string | URL | RequestOptions,
	cb?: (response: ServerResponse | ResponseLike) => void
) => CacheableRequest.Emitter;

type CheckServerIdentityFunction = (hostname: string, certificate: DetailedPeerCertificate) => Error | void;
export type ParseJsonFunction = (text: string) => unknown;
export type StringifyJsonFunction = (object: unknown) => string;

interface RealRequestOptions extends https.RequestOptions {
	checkServerIdentity: CheckServerIdentityFunction;
}

interface PlainOptions extends URLOptions {
	request?: RequestFunction;
	agent?: Agents | false;
	decompress?: boolean;
	timeout?: Delays | number;
	prefixUrl?: string | URL;
	body?: string | Buffer | Readable;
	form?: {[key: string]: any};
	json?: {[key: string]: any};
	url?: string | URL;
	cookieJar?: PromiseCookieJar | ToughCookieJar;
	ignoreInvalidCookies?: boolean;
	searchParams?: string | {[key: string]: string | number | boolean | null | undefined} | URLSearchParams;
	dnsCache?: CacheableLookup | boolean;
	context?: Record<string, unknown>;
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
	headers?: Headers;
	methodRewriting?: boolean;
	dnsLookupIpVersion?: DnsLookupIpVersion;
	parseJson?: ParseJsonFunction;
	stringifyJson?: StringifyJsonFunction;

	// From `http.RequestOptions`
	localAddress?: string;
	socketPath?: string;
	method?: Method;
	createConnection?: (options: http.RequestOptions, oncreate: (error: Error, socket: Socket) => void) => Socket;

	// TODO: remove when Got 12 gets released
	rejectUnauthorized?: boolean; // Here for backwards compatibility

	https?: HTTPSOptions;
}

export interface Options extends PromiseOnly.Options, PlainOptions {}

export interface HTTPSOptions {
	// From `http.RequestOptions` and `tls.CommonConnectionOptions`
	rejectUnauthorized?: https.RequestOptions['rejectUnauthorized'];

	// From `tls.ConnectionOptions`
	checkServerIdentity?: CheckServerIdentityFunction;

	// From `tls.SecureContextOptions`
	certificateAuthority?: SecureContextOptions['ca'];
	key?: SecureContextOptions['key'];
	certificate?: SecureContextOptions['cert'];
	passphrase?: SecureContextOptions['passphrase'];
}

interface NormalizedPlainOptions extends PlainOptions {
	method: Method;
	url: URL;
	timeout: Delays;
	prefixUrl: string;
	ignoreInvalidCookies: boolean;
	decompress: boolean;
	searchParams?: URLSearchParams;
	cookieJar?: PromiseCookieJar;
	headers: Headers;
	context: Record<string, unknown>;
	hooks: Required<Hooks>;
	followRedirect: boolean;
	maxRedirects: number;
	cache?: string | CacheableRequest.StorageAdapter;
	throwHttpErrors: boolean;
	dnsCache?: CacheableLookup;
	http2: boolean;
	allowGetBody: boolean;
	rejectUnauthorized: boolean;
	lookup?: CacheableLookup['lookup'];
	methodRewriting: boolean;
	username: string;
	password: string;
	parseJson: ParseJsonFunction;
	stringifyJson: StringifyJsonFunction;
	[kRequest]: HttpRequestFunction;
	[kIsNormalizedAlready]?: boolean;
}

export interface NormalizedOptions extends PromiseOnly.NormalizedOptions, NormalizedPlainOptions {}

interface PlainDefaults {
	timeout: Delays;
	prefixUrl: string;
	method: Method;
	ignoreInvalidCookies: boolean;
	decompress: boolean;
	context: Record<string, unknown>;
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
	https?: HTTPSOptions;
	methodRewriting: boolean;
	parseJson: ParseJsonFunction;
	stringifyJson: StringifyJsonFunction;

	// Optional
	agent?: Agents | false;
	request?: RequestFunction;
	searchParams?: URLSearchParams;
	lookup?: CacheableLookup['lookup'];
	localAddress?: string;
	createConnection?: Options['createConnection'];
}

export interface Defaults extends PromiseOnly.Defaults, PlainDefaults {}

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
	rawBody: Buffer;
	retryCount: number;
}

export interface RequestEvents<T> {
	on: ((name: 'request', listener: (request: http.ClientRequest) => void) => T)
	& (<R extends Response>(name: 'response', listener: (response: R) => void) => T)
	& (<R extends Response, N extends NormalizedOptions>(name: 'redirect', listener: (response: R, nextOptions: N) => void) => T)
	& ((name: 'uploadProgress' | 'downloadProgress', listener: (progress: Progress) => void) => T);
}

function validateSearchParameters(searchParameters: Record<string, unknown>): asserts searchParameters is Record<string, string | number | boolean | null | undefined> {
	// eslint-disable-next-line guard-for-in
	for (const key in searchParameters) {
		const value = searchParameters[key];

		if (!is.string(value) && !is.number(value) && !is.boolean(value) && !is.null_(value) && !is.undefined(value)) {
			throw new TypeError(`The \`searchParams\` value '${String(value)}' must be a string, number, boolean or null`);
		}
	}
}

function isClientRequest(clientRequest: unknown): clientRequest is ClientRequest {
	return is.object(clientRequest) && !('statusCode' in clientRequest);
}

const cacheableStore = new WeakableMap<string | CacheableRequest.StorageAdapter, CacheableRequestFunction>();

const waitForOpenFile = async (file: ReadStream): Promise<void> => new Promise((resolve, reject) => {
	const onError = (error: Error): void => {
		reject(error);
	};

	// Node.js 12 has incomplete types
	if (!(file as any).pending) {
		resolve();
	}

	file.once('error', onError);
	file.once('ready', () => {
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

export const setNonEnumerableProperties = (sources: Array<Options | Defaults | undefined>, to: Options): void => {
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
				// @ts-expect-error TS doesn't see the check above
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

	constructor(message: string, error: Partial<Error & {code?: string}>, self: Request | NormalizedOptions) {
		super(message);
		Error.captureStackTrace(this, this.constructor);

		this.name = 'RequestError';
		this.code = error.code;

		if (self instanceof Request) {
			Object.defineProperty(this, 'request', {
				enumerable: false,
				value: self
			});

			Object.defineProperty(this, 'response', {
				enumerable: false,
				value: self[kResponse]
			});

			Object.defineProperty(this, 'options', {
				// This fails because of TS 3.7.2 useDefineForClassFields
				// Ref: https://github.com/microsoft/TypeScript/issues/34972
				enumerable: false,
				value: self.options
			});
		} else {
			Object.defineProperty(this, 'options', {
				// This fails because of TS 3.7.2 useDefineForClassFields
				// Ref: https://github.com/microsoft/TypeScript/issues/34972
				enumerable: false,
				value: self
			});
		}

		this.timings = this.request?.timings;

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
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(request: Request) {
		super(`Redirected ${request.options.maxRedirects} times. Aborting.`, {}, request);
		this.name = 'MaxRedirectsError';
	}
}

export class HTTPError extends RequestError {
	declare readonly response: Response;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(response: Response) {
		super(`Response code ${response.statusCode} (${response.statusMessage!})`, {}, response.request);
		this.name = 'HTTPError';
	}
}

export class CacheError extends RequestError {
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'CacheError';
	}
}

export class UploadError extends RequestError {
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'UploadError';
	}
}

export class TimeoutError extends RequestError {
	declare readonly request: Request;
	readonly timings: Timings;
	readonly event: string;

	constructor(error: TimedOutTimeoutError, timings: Timings, request: Request) {
		super(error.message, error, request);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

export class ReadError extends RequestError {
	declare readonly request: Request;
	declare readonly response: Response;
	declare readonly timings: Timings;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
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
	[kStopReading]: boolean;
	[kTriggerRead]: boolean;
	[kBody]: Options['body'];
	[kJobs]: Array<() => void>;
	[kBodySize]?: number;
	[kServerResponsesPiped]: Set<ServerResponse>;
	[kIsFromCache]?: boolean;
	[kStartedReading]?: boolean;
	[kCancelTimeouts]?: () => void;
	[kResponseSize]?: number;
	[kResponse]?: IncomingMessageWithTimings;
	[kOriginalResponse]?: IncomingMessageWithTimings;
	[kRequest]?: ClientRequest;
	_noPipe?: boolean;
	_progressCallbacks: Array<() => void>;

	declare options: NormalizedOptions;
	declare requestUrl: string;
	requestInitialized: boolean;
	redirects: string[];

	constructor(url: string | URL, options: Options = {}, defaults?: Defaults) {
		super({
			// It needs to be zero because we're just proxying the data to another stream
			highWaterMark: 0
		});

		this[kDownloadedSize] = 0;
		this[kUploadedSize] = 0;
		this.requestInitialized = false;
		this[kServerResponsesPiped] = new Set<ServerResponse>();
		this.redirects = [];
		this[kStopReading] = false;
		this[kTriggerRead] = false;
		this[kJobs] = [];

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
					// @ts-expect-error Common TypeScript bug saying that `this.constructor` is not accessible
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

				if (this.destroyed) {
					this[kRequest]?.destroy();
					return;
				}

				// Queued writes etc.
				for (const job of this[kJobs]) {
					job();
				}

				this.requestInitialized = true;
			} catch (error) {
				if (error instanceof RequestError) {
					this._beforeError(error);
					return;
				}

				// This is a workaround for https://github.com/nodejs/node/issues/33335
				if (!this.destroyed) {
					this.destroy(error);
				}
			}
		})(options);
	}

	static normalizeArguments(url?: string | URL, options?: Options, defaults?: Defaults): NormalizedOptions {
		const rawOptions = options;

		if (is.object(url) && !is.urlInstance(url)) {
			options = {...defaults, ...(url as Options), ...options};
		} else {
			if (url && options && options.url !== undefined) {
				throw new TypeError('The `url` option is mutually exclusive with the `input` argument');
			}

			options = {...defaults, ...options};

			if (url !== undefined) {
				options.url = url;
			}

			if (is.urlInstance(options.url)) {
				options.url = new URL(options.url.toString());
			}
		}

		// TODO: Deprecate URL options in Got 12.

		// Support extend-specific options
		if (options.cache === false) {
			options.cache = undefined;
		}

		if (options.dnsCache === false) {
			options.dnsCache = undefined;
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
		assert.any([is.boolean, is.undefined], options.followRedirect);
		assert.any([is.number, is.undefined], options.maxRedirects);
		assert.any([is.boolean, is.undefined], options.throwHttpErrors);
		assert.any([is.boolean, is.undefined], options.http2);
		assert.any([is.boolean, is.undefined], options.allowGetBody);
		assert.any([is.string, is.undefined], options.localAddress);
		assert.any([isDnsLookupIpVersion, is.undefined], options.dnsLookupIpVersion);
		assert.any([is.object, is.undefined], options.https);
		assert.any([is.boolean, is.undefined], options.rejectUnauthorized);
		if (options.https) {
			assert.any([is.boolean, is.undefined], options.https.rejectUnauthorized);
			assert.any([is.function_, is.undefined], options.https.checkServerIdentity);
			assert.any([is.string, is.object, is.array, is.undefined], options.https.certificateAuthority);
			assert.any([is.string, is.object, is.array, is.undefined], options.https.key);
			assert.any([is.string, is.object, is.array, is.undefined], options.https.certificate);
			assert.any([is.string, is.undefined], options.https.passphrase);
		}

		// `options.method`
		if (is.string(options.method)) {
			options.method = options.method.toUpperCase() as Method;
		} else {
			options.method = 'GET';
		}

		// `options.headers`
		if (options.headers === defaults?.headers) {
			options.headers = {...options.headers};
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

		// `options.searchParams`
		if ('searchParams' in options) {
			if (options.searchParams && options.searchParams !== defaults?.searchParams) {
				let searchParameters: URLSearchParams;

				if (is.string(options.searchParams) || (options.searchParams instanceof URLSearchParams)) {
					searchParameters = new URLSearchParams(options.searchParams);
				} else {
					validateSearchParameters(options.searchParams);

					searchParameters = new URLSearchParams();

					// eslint-disable-next-line guard-for-in
					for (const key in options.searchParams) {
						const value = options.searchParams[key];

						if (value === null) {
							searchParameters.append(key, '');
						} else if (value !== undefined) {
							searchParameters.append(key, value as string);
						}
					}
				}

				// `normalizeArguments()` is also used to merge options
				defaults?.searchParams?.forEach((value, key) => {
					// Only use default if one isn't already defined
					if (!searchParameters.has(key)) {
						searchParameters.append(key, value);
					}
				});

				options.searchParams = searchParameters;
			}
		}

		// `options.username` & `options.password`
		options.username = options.username ?? '';
		options.password = options.password ?? '';

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

			// Support UNIX sockets
			let {protocol} = options.url;

			if (protocol === 'unix:') {
				protocol = 'http:';

				options.url = new URL(`http://unix${options.url.pathname}${options.url.search}`);
			}

			// Set search params
			if (options.searchParams) {
				// eslint-disable-next-line @typescript-eslint/no-base-to-string
				options.url.search = options.searchParams.toString();
			}

			// Protocol check
			if (protocol !== 'http:' && protocol !== 'https:') {
				throw new UnsupportedProtocolError(options as NormalizedOptions);
			}

			// Update `username`
			if (options.username === '') {
				options.username = options.url.username;
			} else {
				options.url.username = options.username;
			}

			// Update `password`
			if (options.password === '') {
				options.password = options.url.password;
			} else {
				options.url.password = options.password;
			}
		}

		// `options.cookieJar`
		const {cookieJar} = options;
		if (cookieJar) {
			let {setCookie, getCookieString} = cookieJar;

			assert.function_(setCookie);
			assert.function_(getCookieString);

			/* istanbul ignore next: Horrible `tough-cookie` v3 check */
			if (setCookie.length === 4 && getCookieString.length === 0) {
				setCookie = promisify(setCookie.bind(options.cookieJar));
				getCookieString = promisify(getCookieString.bind(options.cookieJar));

				options.cookieJar = {
					setCookie,
					// TODO: Fix this when upgrading to TypeScript 4.
					// @ts-expect-error TypeScript thinks that promisifying callback(error, string) will result in Promise<void>
					getCookieString
				};
			}
		}

		// `options.cache`
		const {cache} = options;
		if (cache) {
			if (!cacheableStore.has(cache)) {
				cacheableStore.set(cache, new CacheableRequest(
					((requestOptions: RequestOptions, handler?: (response: IncomingMessageWithTimings) => void): ClientRequest => {
						const result = (requestOptions as Pick<NormalizedOptions, typeof kRequest>)[kRequest](requestOptions, handler);

						// TODO: remove this when `cacheable-request` supports async request functions.
						if (is.promise(result)) {
							// @ts-expect-error
							// We only need to implement the error handler in order to support HTTP2 caching.
							// The result will be a promise anyway.
							result.once = (event: string, handler: (reason: unknown) => void) => {
								if (event === 'error') {
									result.catch(handler);
								} else if (event === 'abort') {
									// The empty catch is needed here in case when
									// it rejects before it's `await`ed in `_makeRequest`.
									(async () => {
										try {
											const request = (await result) as ClientRequest;
											request.once('abort', handler);
										} catch {}
									})();
								} else {
									/* istanbul ignore next: safety check */
									throw new Error(`Unknown HTTP2 promise event: ${event}`);
								}

								return result;
							};
						}

						return result;
					}) as HttpRequestFunction,
					cache as CacheableRequest.StorageAdapter
				));
			}
		}

		// `options.dnsCache`
		if (options.dnsCache === true) {
			options.dnsCache = globalDnsCache;
		} else if (!is.undefined(options.dnsCache) && !options.dnsCache.lookup) {
			throw new TypeError(`Parameter \`dnsCache\` must be a CacheableLookup instance or a boolean, got ${is(options.dnsCache)}`);
		}

		// `options.timeout`
		if (is.number(options.timeout)) {
			options.timeout = {request: options.timeout};
		} else if (defaults && options.timeout !== defaults.timeout) {
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
		const areHooksDefault = options.hooks === defaults?.hooks;
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

		if (defaults && !areHooksDefault) {
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

		// DNS options
		if ('family' in options) {
			deprecationWarning('"options.family" was never documented, please use "options.dnsLookupIpVersion"');
		}

		// HTTPS options
		if (defaults?.https) {
			options.https = {...defaults.https, ...options.https};
		}

		if ('rejectUnauthorized' in options) {
			deprecationWarning('"options.rejectUnauthorized" is now deprecated, please use "options.https.rejectUnauthorized"');
		}

		if ('checkServerIdentity' in options) {
			deprecationWarning('"options.checkServerIdentity" was never documented, please use "options.https.checkServerIdentity"');
		}

		if ('ca' in options) {
			deprecationWarning('"options.ca" was never documented, please use "options.https.certificateAuthority"');
		}

		if ('key' in options) {
			deprecationWarning('"options.key" was never documented, please use "options.https.key"');
		}

		if ('cert' in options) {
			deprecationWarning('"options.cert" was never documented, please use "options.https.certificate"');
		}

		if ('passphrase' in options) {
			deprecationWarning('"options.passphrase" was never documented, please use "options.https.passphrase"');
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
		setNonEnumerableProperties([defaults, rawOptions], options);

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

					this[kBody] = options.body;
				} else if (isForm) {
					if (noContentType) {
						headers['content-type'] = 'application/x-www-form-urlencoded';
					}

					this[kBody] = (new URLSearchParams(options.form as Record<string, string>)).toString();
				} else {
					if (noContentType) {
						headers['content-type'] = 'application/json';
					}

					this[kBody] = options.stringifyJson(options.json);
				}

				const uploadBodySize = await getBodySize(this[kBody], options.headers);

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

	async _onResponseBase(response: IncomingMessageWithTimings): Promise<void> {
		const {options} = this;
		const {url} = options;

		this[kOriginalResponse] = response;

		if (options.decompress) {
			response = decompressResponse(response);
		}

		const statusCode = response.statusCode!;
		const typedResponse = response as Response;

		typedResponse.statusMessage = typedResponse.statusMessage ? typedResponse.statusMessage : http.STATUS_CODES[statusCode];
		typedResponse.url = options.url.toString();
		typedResponse.requestUrl = this.requestUrl;
		typedResponse.redirectUrls = this.redirects;
		typedResponse.request = this;
		typedResponse.isFromCache = (response as any).fromCache || false;
		typedResponse.ip = this.ip;

		this[kIsFromCache] = typedResponse.isFromCache;

		this[kResponseSize] = Number(response.headers['content-length']) || undefined;
		this[kResponse] = response;

		response.once('end', () => {
			this[kResponseSize] = this[kDownloadedSize];
			this.emit('downloadProgress', this.downloadProgress);
		});

		response.once('error', (error: Error) => {
			// Force clean-up, because some packages don't do this.
			// TODO: Fix decompress-response
			response.destroy();

			this._beforeError(new ReadError(error, this));
		});

		response.once('aborted', () => {
			this._beforeError(new ReadError({
				name: 'Error',
				message: 'The server aborted pending request',
				code: 'ECONNRESET'
			}, this));
		});

		this.emit('downloadProgress', this.downloadProgress);

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
				this._beforeError(new MaxRedirectsError(this));
				return;
			}

			try {
				// Do not remove. See https://github.com/sindresorhus/got/pull/214
				const redirectBuffer = Buffer.from(response.headers.location, 'binary').toString();

				// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
				const redirectUrl = new URL(redirectBuffer, url);
				const redirectString = redirectUrl.toString();
				decodeURI(redirectString);

				// Redirecting to a different site, clear sensitive data.
				if (redirectUrl.hostname !== url.hostname) {
					if ('host' in options.headers) {
						delete options.headers.host;
					}

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
			// Normally we would have to use `void [await] this._beforeError(error)` everywhere,
			// but since there's `void (async () => { ... })()` inside of it, we don't have to.
			this._beforeError(new HTTPError(typedResponse));

			// This is equivalent to this.destroyed
			if (this[kStopReading]) {
				return;
			}
		}

		response.on('readable', () => {
			if (this[kTriggerRead]) {
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
			this.push(null);
		});

		this.emit('response', response);

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
	}

	async _onResponse(response: IncomingMessageWithTimings): Promise<void> {
		try {
			await this._onResponseBase(response);
		} catch (error) {
			this._beforeError(error);
		}
	}

	_onRequest(request: ClientRequest): void {
		const {options} = this;
		const {timeout, url} = options;

		timer(request);

		this[kCancelTimeouts] = timedOut(request, timeout, url);

		const responseEventName = options.cache ? 'cacheableResponse' : 'response';

		request.once(responseEventName, (response: IncomingMessageWithTimings) => {
			void this._onResponse(response);
		});

		request.once('error', (error: Error) => {
			// Force clean-up, because some packages (e.g. nock) don't do this.
			request.destroy();

			// Node.js <= 12.18.2 mistakenly emits the response `end` first.
			(request as ClientRequest & {res: IncomingMessage | undefined}).res?.removeAllListeners('end');

			if (error instanceof TimedOutTimeoutError) {
				error = new TimeoutError(error, this.timings!, this);
			} else {
				error = new RequestError(error.message, error, this);
			}

			this._beforeError(error as RequestError);
		});

		this[kUnproxyEvents] = proxyEvents(request, this, proxiedRequestEvents);

		this[kRequest] = request;

		this.emit('uploadProgress', this.uploadProgress);

		// Send body
		const body = this[kBody];
		const currentRequest = this.redirects.length === 0 ? this : request;

		if (is.nodeStream(body)) {
			body.pipe(currentRequest);
			body.once('error', (error: NodeJS.ErrnoException) => {
				this._beforeError(new UploadError(error, this));
			});

			body.once('end', () => {
				delete options.body;
			});
		} else {
			this._unlockWrite();

			if (!is.undefined(body)) {
				this._writeRequest(body, undefined, () => {});
				currentRequest.end();

				this._lockWrite();
			} else if (this._cannotHaveBody || this._noPipe) {
				currentRequest.end();

				this._lockWrite();
			}
		}

		this.emit('request', request);
	}

	async _createCacheableRequest(url: URL, options: RequestOptions): Promise<ClientRequest | ResponseLike> {
		return new Promise<ClientRequest | ResponseLike>((resolve, reject) => {
			// TODO: Remove `utils/url-to-options.ts` when `cacheable-request` is fixed
			Object.assign(options, urlToOptions(url));

			// `http-cache-semantics` checks this
			delete (options as unknown as NormalizedOptions).url;

			let request: ClientRequest | Promise<ClientRequest>;

			// This is ugly
			const cacheRequest = cacheableStore.get((options as any).cache)!(options, async response => {
				// TODO: Fix `cacheable-response`
				(response as any)._readableState.autoDestroy = false;

				if (request) {
					(await request).emit('cacheableResponse', response);
				}

				resolve(response as unknown as ResponseLike);
			});

			// Restore options
			(options as unknown as NormalizedOptions).url = url;

			cacheRequest.once('error', reject);
			cacheRequest.once('request', async (requestOrPromise: ClientRequest | Promise<ClientRequest>) => {
				request = requestOrPromise;
				resolve(request);
			});
		});
	}

	async _makeRequest(): Promise<void> {
		const {options} = this;

		const {headers} = options;

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
				// @ts-expect-error Skip the type mismatch to support abstract responses
				options.request = () => result;
				break;
			}
		}

		const {agent, request, timeout, url} = options;

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

		// Fallback function
		let fallbackFn: HttpRequestFunction;
		if (options.http2) {
			fallbackFn = http2wrapper.auto;
		} else {
			fallbackFn = isHttps ? https.request : http.request;
		}

		const realFn = options.request ?? fallbackFn;

		// Cache support
		const fn = options.cache ? this._createCacheableRequest : realFn;

		// Pass an agent directly when HTTP2 is disabled
		if (agent && !options.http2) {
			(options as unknown as RequestOptions).agent = agent[isHttps ? 'https' : 'http'];
		}

		// Prepare plain HTTP request options
		options[kRequest] = realFn as HttpRequestFunction;
		delete options.request;
		delete options.timeout;

		const requestOptions = options as unknown as RealRequestOptions;

		// If `dnsLookupIpVersion` is not present do not override `family`
		if (options.dnsLookupIpVersion !== undefined) {
			try {
				requestOptions.family = dnsLookupIpVersionToFamily(options.dnsLookupIpVersion);
			} catch {
				throw new Error('Invalid `dnsLookupIpVersion` option value');
			}
		}

		// HTTPS options remapping
		if (options.https) {
			if ('rejectUnauthorized' in options.https) {
				requestOptions.rejectUnauthorized = options.https.rejectUnauthorized;
			}

			if (options.https.checkServerIdentity) {
				requestOptions.checkServerIdentity = options.https.checkServerIdentity;
			}

			if (options.https.certificateAuthority) {
				requestOptions.ca = options.https.certificateAuthority;
			}

			if (options.https.certificate) {
				requestOptions.cert = options.https.certificate;
			}

			if (options.https.key) {
				requestOptions.key = options.https.key;
			}

			if (options.https.passphrase) {
				requestOptions.passphrase = options.https.passphrase;
			}
		}

		try {
			let requestOrResponse = await fn(url, requestOptions);

			if (is.undefined(requestOrResponse)) {
				requestOrResponse = fallbackFn(url, requestOptions);
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
					void this._onResponse(requestOrResponse as IncomingMessageWithTimings);
				});

				this._unlockWrite();
				this.end();
				this._lockWrite();
			} else {
				void this._onResponse(requestOrResponse as IncomingMessageWithTimings);
			}
		} catch (error) {
			if (error instanceof CacheableRequest.CacheError) {
				throw new CacheError(error, this);
			}

			throw new RequestError(error.message, error, this);
		}
	}

	_beforeError(error: Error): void {
		if (this.destroyed) {
			return;
		}

		this[kStopReading] = true;

		if (!(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		void (async () => {
			try {
				const {response} = error as RequestError;

				if (response) {
					response.setEncoding((this as any)._readableState.encoding);

					response.rawBody = await getBuffer(response);
					response.body = response.rawBody.toString();
				}
			} catch {}

			try {
				for (const hook of this.options.hooks.beforeError) {
					// eslint-disable-next-line no-await-in-loop
					error = await hook(error as RequestError);
				}
			} catch (error_) {
				error = new RequestError(error_.message, error_, this);
			}

			this.destroy(error);
		})();
	}

	_read(): void {
		this[kTriggerRead] = true;

		const response = this[kResponse];
		if (response && !this[kStopReading]) {
			// We cannot put this in the `if` above
			// because `.read()` also triggers the `end` event
			if (response.readableLength) {
				this[kTriggerRead] = false;
			}

			let data;
			while ((data = response.read()) !== null) {
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

	// Node.js 12 has incorrect types, so the encoding must be a string
	_write(chunk: any, encoding: string | undefined, callback: (error?: Error | null) => void): void {
		const write = (): void => {
			this._writeRequest(chunk, encoding as BufferEncoding, callback);
		};

		if (this.requestInitialized) {
			write();
		} else {
			this[kJobs].push(write);
		}
	}

	_writeRequest(chunk: any, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void {
		this._progressCallbacks.push((): void => {
			this[kUploadedSize] += Buffer.byteLength(chunk, encoding);

			const progress = this.uploadProgress;

			if (progress.percent < 1) {
				this.emit('uploadProgress', progress);
			}
		});

		// TODO: What happens if it's from cache? Then this[kRequest] won't be defined.

		this[kRequest]!.write(chunk, encoding!, (error?: Error | null) => {
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

			if (this[kRequest]!.destroyed) {
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

		if (this.requestInitialized) {
			endRequest();
		} else {
			this[kJobs].push(endRequest);
		}
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this[kStopReading] = true;

		if (kRequest in this) {
			this[kCancelTimeouts]!();

			// TODO: Remove the next `if` when these get fixed:
			// - https://github.com/nodejs/node/issues/32851
			if (!this[kResponse]?.complete) {
				this[kRequest]!.destroy();
			}
		}

		if (error !== null && !is.undefined(error) && !(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		callback(error);
	}

	get ip(): string | undefined {
		return this[kRequest]?.socket.remoteAddress;
	}

	get aborted(): boolean {
		return (this[kRequest]?.destroyed ?? this.destroyed) && !(this[kOriginalResponse]?.complete);
	}

	get socket(): Socket | undefined {
		return this[kRequest]?.socket;
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

	get _response(): Response | undefined {
		return this[kResponse] as Response;
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
