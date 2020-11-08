import {promisify} from 'util';
import {Readable} from 'stream';
import {Socket} from 'net';
import {SecureContextOptions, DetailedPeerCertificate} from 'tls';
import {URL, URLSearchParams} from 'url';
import {
	request as requestHttp,
	Agent as HttpAgent,
	ClientRequest
} from 'http';
import {
	RequestOptions,
	request as requestHttps,
	Agent as HttpsAgent
} from 'https';
import CacheableLookup from 'cacheable-lookup';
import CacheableRequest = require('cacheable-request');
import lowercaseKeys = require('lowercase-keys');
import ResponseLike = require('responselike');
import is, {assert} from '@sindresorhus/is';
import {IncomingMessageWithTimings, Timings} from '@szmarczak/http-timer';
import {DnsLookupIpVersion, isDnsLookupIpVersion} from './utils/dns-ip-version';
import {Delays} from './utils/timed-out';
import {PromiseOnly} from '../as-promise/types';
import {Options as OptionsInit} from '.';

type AcceptableResponse = IncomingMessageWithTimings | ResponseLike;
type AcceptableRequestResult = AcceptableResponse | ClientRequest | Promise<AcceptableResponse | ClientRequest> | undefined;
export type RequestFunction = (url: URL, options: RequestOptions, callback?: (response: AcceptableResponse) => void) => AcceptableRequestResult;

export interface PlainResponse extends IncomingMessageWithTimings {
	/**
	The original request URL.
	*/
	requestUrl: string;

	/**
	The redirect URLs.
	*/
	redirectUrls: string[];

	/**
	- `options` - The Got options that were set on this request.

	__Note__: This is not a [http.ClientRequest](https://nodejs.org/api/http.html#http_class_http_clientrequest).
	*/
	request: Request;

	/**
	The remote IP address.

	This is hopefully a temporary limitation, see [lukechilds/cacheable-request#86](https://github.com/lukechilds/cacheable-request/issues/86).

	__Note__: Not available when the response is cached.
	*/
	ip?: string;

	/**
	Whether the response was retrieved from the cache.
	*/
	isFromCache: boolean;

	/**
	The status code of the response.
	*/
	statusCode: number;

	/**
	The request URL or the final URL after redirects.
	*/
	url: string;

	/**
	The object contains the following properties:

	- `start` - Time when the request started.
	- `socket` - Time when a socket was assigned to the request.
	- `lookup` - Time when the DNS lookup finished.
	- `connect` - Time when the socket successfully connected.
	- `secureConnect` - Time when the socket securely connected.
	- `upload` - Time when the request finished uploading.
	- `response` - Time when the request fired `response` event.
	- `end` - Time when the response fired `end` event.
	- `error` - Time when the request fired `error` event.
	- `abort` - Time when the request fired `abort` event.
	- `phases`
		- `wait` - `timings.socket - timings.start`
		- `dns` - `timings.lookup - timings.socket`
		- `tcp` - `timings.connect - timings.lookup`
		- `tls` - `timings.secureConnect - timings.connect`
		- `request` - `timings.upload - (timings.secureConnect || timings.connect)`
		- `firstByte` - `timings.response - timings.upload`
		- `download` - `timings.end - timings.response`
		- `total` - `(timings.end || timings.error || timings.abort) - timings.start`

	If something has not been measured yet, it will be `undefined`.

	__Note__: The time is a `number` representing the milliseconds elapsed since the UNIX epoch.
	*/
	timings: Timings;

	/**
	The number of times the request was retried.
	*/
	retryCount: number;

	// Defined only if request errored
	/**
	The raw result of the request.
	*/
	rawBody?: Buffer;

	/**
	The result of the request.
	*/
	body?: unknown;
}

// For Promise support
export interface Response<T = unknown> extends PlainResponse {
	/**
	The result of the request.
	*/
	body: T;

	/**
	The raw result of the request.
	*/
	rawBody: Buffer;
}

export interface Agents {
	http?: HttpAgent | false;
	https?: HttpsAgent | false;
	http2?: unknown | false;
}

export interface ToughCookieJar {
	getCookieString: ((currentUrl: string, options: Record<string, unknown>, cb: (err: Error | null, cookies: string) => void) => void)
	& ((url: string, callback: (error: Error | null, cookieHeader: string) => void) => void);
	setCookie: ((cookieOrString: unknown, currentUrl: string, options: Record<string, unknown>, cb: (err: Error | null, cookie: unknown) => void) => void)
	& ((rawCookie: string, url: string, callback: (error: Error | null, result: unknown) => void) => void);
}

export interface PromiseCookieJar {
	getCookieString: (url: string) => Promise<string>;
	setCookie: (rawCookie: string, url: string) => Promise<unknown>;
}

type Promisable<T> = T | Promise<T>;

export type InitHook<ErrorType extends NodeJS.ErrnoException> = (options: Options<ErrorType>) => void;
export type BeforeRequestHook<ErrorType extends NodeJS.ErrnoException> = (options: Options<ErrorType>) => Promisable<void | Response | ResponseLike>;
export type BeforeRedirectHook<ErrorType extends NodeJS.ErrnoException> = (options: Options<ErrorType>, response: Response) => Promisable<void>;
export type BeforeErrorHook<ErrorType extends NodeJS.ErrnoException> = (error: ErrorType) => Promisable<ErrorType>;
export type BeforeRetryHook<ErrorType extends NodeJS.ErrnoException> = (options: Options<ErrorType>, error?: ErrorType, retryCount?: number) => void | Promise<void>;

interface PlainHooks<ErrorType extends NodeJS.ErrnoException> {
	/**
	Called with plain request options, right before their normalization.
	This is especially useful in conjunction with `got.extend()` when the input needs custom handling.

	__Note #1__: This hook must be synchronous!

	__Note #2__: Errors in this hook will be converted into an instances of `RequestError`.

	__Note #3__: The options object may not have a `url` property.
	To modify it, use a `beforeRequest` hook instead.

	@default []
	*/
	init: InitHook<ErrorType>[];

	/**
	Called with normalized request options.
	Got will make no further changes to the request before it is sent.
	This is especially useful in conjunction with `got.extend()` when you want to create an API client that, for example, uses HMAC-signing.

	@default []
	*/
	beforeRequest: BeforeRequestHook<ErrorType>[];

	/**
	Called with normalized request options and the redirect response.
	Got will make no further changes to the request.
	This is especially useful when you want to avoid dead sites.

	@default []

	@example
	```
	const got = require('got');

	got('https://example.com', {
		hooks: {
			beforeRedirect: [
				(options, response) => {
					if (options.hostname === 'deadSite') {
						options.hostname = 'fallbackSite';
					}
				}
			]
		}
	});
	```
	*/
	beforeRedirect: BeforeRedirectHook<ErrorType>[];

	/**
	Called with an `Error` instance.
	The error is passed to the hook right before it's thrown.
	This is especially useful when you want to have more detailed errors.

	__Note__: Errors thrown while normalizing input options are thrown directly and not part of this hook.

	@default []

	@example
	```
	const got = require('got');

	got('https://api.github.com/some-endpoint', {
		hooks: {
			beforeError: [
				error => {
					const {response} = error;
					if (response && response.body) {
						error.name = 'GitHubError';
						error.message = `${response.body.message} (${response.statusCode})`;
					}

					return error;
				}
			]
		}
	});
	```
	*/
	beforeError: BeforeErrorHook<ErrorType>[];

	/**
	Called with normalized request options, the error and the retry count.
  Got will make no further changes to the request.
	This is especially useful when some extra work is required before the next try.

	__Note__: When using streams, this hook is ignored.
	__Note__: When retrying in a `afterResponse` hook, all remaining `beforeRetry` hooks will be called without the `error` and `retryCount` arguments.

	@default []

	@example
	```
	const got = require('got');

	got.post('https://example.com', {
		hooks: {
			beforeRetry: [
				(options, error, retryCount) => {
					if (error.response.statusCode === 413) { // Payload too large
						options.body = getNewBody();
					}
				}
			]
		}
	});
	```
	*/
	beforeRetry: BeforeRetryHook<ErrorType>[];
}

/**
All available hook of Got.
*/
export interface Hooks<ErrorType extends NodeJS.ErrnoException> extends PromiseOnly.Hooks, PlainHooks<ErrorType> {}

export type ParseJsonFunction = (text: string) => unknown;
export type StringifyJsonFunction = (object: unknown) => string;

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

export interface RetryObject {
	attemptCount: number;
	retryOptions: RetryOptions;
	error: NodeJS.ErrnoException;
	computedValue: number;
	retryAfter?: number;
}

export type RetryFunction = (retryObject: RetryObject) => number | Promise<number>;

/**
An object representing `limit`, `calculateDelay`, `methods`, `statusCodes`, `maxRetryAfter` and `errorCodes` fields for maximum retry count, retry handler, allowed methods, allowed status codes, maximum [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) time and allowed error codes.

Delays between retries counts with function `1000 * Math.pow(2, retry) + Math.random() * 100`, where `retry` is attempt number (starts from 1).

The `calculateDelay` property is a `function` that receives an object with `attemptCount`, `retryOptions`, `error` and `computedValue` properties for current retry count, the retry options, error and default computed value.
The function must return a delay in milliseconds (or a Promise resolving with it) (`0` return value cancels retry).

By default, it retries *only* on the specified methods, status codes, and on these network errors:
- `ETIMEDOUT`: One of the [timeout](#timeout) limits were reached.
- `ECONNRESET`: Connection was forcibly closed by a peer.
- `EADDRINUSE`: Could not bind to any free port.
- `ECONNREFUSED`: Connection was refused by the server.
- `EPIPE`: The remote side of the stream being written has been closed.
- `ENOTFOUND`: Couldn't resolve the hostname to an IP address.
- `ENETUNREACH`: No internet connection.
- `EAI_AGAIN`: DNS lookup timed out.

__Note__: If `maxRetryAfter` is set to `undefined`, it will use `options.timeout`.
__Note__: If [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header is greater than `maxRetryAfter`, it will cancel the request.
*/
export interface RetryOptions {
	limit: number;
	methods: Method[];
	statusCodes: number[];
	errorCodes: string[];
	calculateDelay: RetryFunction;
	maxRetryAfter?: number;
}

export type CreateConnectionFunction = (options: RequestOptions, oncreate: (error: Error, socket: Socket) => void) => Socket;
export type CheckServerIdentityFunction = (hostname: string, certificate: DetailedPeerCertificate) => Error | void;

export interface CacheOptions {
	shared?: boolean;
	cacheHeuristic?: number;
	immutableMinTimeToLive?: number;
	ignoreCargoCult?: boolean;
}

export interface HttpsOptions {
	// From `http.RequestOptions` and `tls.CommonConnectionOptions`
	rejectUnauthorized?: RequestOptions['rejectUnauthorized'];

	// From `tls.ConnectionOptions`
	checkServerIdentity?: CheckServerIdentityFunction;

	// From `tls.SecureContextOptions`
	/**
	Override the default Certificate Authorities ([from Mozilla](https://ccadb-public.secure.force.com/mozilla/IncludedCACertificateReport)).

	@example
	```
	// Single Certificate Authority
	got('https://example.com', {
		https: {
			certificateAuthority: fs.readFileSync('./my_ca.pem')
		}
	});
	```
	*/
	certificateAuthority?: SecureContextOptions['ca'];

	/**
	Private keys in [PEM](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail) format.

	[PEM](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail) allows the option of private keys being encrypted.
	Encrypted keys will be decrypted with `options.https.passphrase`.

	Multiple keys with different passphrases can be provided as an array of `{pem: <string | Buffer>, passphrase: <string>}`
	*/
	key?: SecureContextOptions['key'];

	/**
	[Certificate chains](https://en.wikipedia.org/wiki/X.509#Certificate_chains_and_cross-certification) in [PEM](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail) format.

	One cert chain should be provided per private key (`options.https.key`).

	When providing multiple cert chains, they do not have to be in the same order as their private keys in `options.https.key`.

	If the intermediate certificates are not provided, the peer will not be able to validate the certificate, and the handshake will fail.
	*/
	certificate?: SecureContextOptions['cert'];

	/**
	The passphrase to decrypt the `options.https.key` (if different keys have different passphrases refer to `options.https.key` documentation).
	*/
	passphrase?: SecureContextOptions['passphrase'];
	pfx?: SecureContextOptions['pfx'];
}

export interface PaginationOptions<ItemType, BodyType, ErrorType extends NodeJS.ErrnoException> {
	/**
	A function that transform [`Response`](#response) into an array of items.
	This is where you should do the parsing.

	@default response => JSON.parse(response.body)
	*/
	transform?: (response: Response<BodyType>) => Promise<ItemType[]> | ItemType[];

	/**
	Checks whether the item should be emitted or not.

	@default (item, allItems, currentItems) => true
	*/
	filter?: (item: ItemType, allItems: ItemType[], currentItems: ItemType[]) => boolean;

	/**
	The function takes three arguments:
	- `response` - The current response object.
	- `allItems` - An array of the emitted items.
	- `currentItems` - Items from the current response.

	It should return an object representing Got options pointing to the next page.
	The options are merged automatically with the previous request, therefore the options returned `pagination.paginate(...)` must reflect changes only.
	If there are no more pages, `false` should be returned.

	@example
	```
	const got = require('got');

	(async () => {
		const limit = 10;

		const items = got.paginate('https://example.com/items', {
			searchParams: {
				limit,
				offset: 0
			},
			pagination: {
				paginate: (response, allItems, currentItems) => {
					const previousSearchParams = response.request.options.searchParams;
					const previousOffset = previousSearchParams.get('offset');

					if (currentItems.length < limit) {
						return false;
					}

					return {
						searchParams: {
							...previousSearchParams,
							offset: Number(previousOffset) + limit,
						}
					};
				}
			}
		});

		console.log('Items from all pages:', items);
	})();
	```
	*/
	paginate?: (response: Response<BodyType>, allItems: ItemType[], currentItems: ItemType[]) => Options<ErrorType> | false;

	/**
	Checks whether the pagination should continue.

	For example, if you need to stop **before** emitting an entry with some flag, you should use `(item, allItems, currentItems) => !item.flag`.
	If you want to stop **after** emitting the entry, you should use `(item, allItems, currentItems) => allItems.some(entry => entry.flag)` instead.

	@default (item, allItems, currentItems) => true
	*/
	shouldContinue?: (item: ItemType, allItems: ItemType[], currentItems: ItemType[]) => boolean;

	/**
	The maximum amount of items that should be emitted.

	@default Infinity
	*/
	countLimit?: number;

	/**
	Milliseconds to wait before the next request is triggered.

	@default 0
	*/
	backoff?: number;
	/**
	The maximum amount of request that should be triggered.
	Retries on failure are not counted towards this limit.

	For example, it can be helpful during development to avoid an infinite number of requests.

	@default 10000
	*/
	requestLimit?: number;

	/**
	Defines how the parameter `allItems` in pagination.paginate, pagination.filter and pagination.shouldContinue is managed.
	When set to `false`, the parameter `allItems` is always an empty array.

	This option can be helpful to save on memory usage when working with a large dataset.
	*/
	stackAllItems?: boolean;
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

export type ResponseType = 'json' | 'buffer' | 'text';

const globalDnsCache = new CacheableLookup();

export class Options<ErrorType extends NodeJS.ErrnoException> {
	private _request?: RequestFunction;
	private _agent: Agents;
	private _decompress: boolean;
	private _timeout: Delays;
	private _prefixUrl: string;
	private _body?: string | Buffer | Readable;
	private _form?: Record<string, any>;
	private _json?: Record<string, any>;
	private _url?: URL;
	private _cookieJar?: PromiseCookieJar | ToughCookieJar;
	private _ignoreInvalidCookies: boolean;
	private _searchParameters?: URLSearchParams;
	private _dnsCache?: CacheableLookup;
	private _context: Record<string, unknown>;
	private _hooks: Hooks<ErrorType>;
	private _followRedirect: boolean;
	private _maxRedirects: number;
	private _cache?: string | CacheableRequest.StorageAdapter | false;
	private _throwHttpErrors: boolean;
	private _username: string;
	private _password: string;
	private _http2: boolean;
	private _allowGetBody: boolean;
	private _lookup?: CacheableLookup['lookup'];
	private _headers: Record<string, string>;
	private _methodRewriting: boolean;
	private _dnsLookupIpVersion: DnsLookupIpVersion;
	private _parseJson?: ParseJsonFunction;
	private _stringifyJson?: StringifyJsonFunction;
	private _retry: RetryOptions;
	private _localAddress?: string;
	private _socketPath?: string;
	private _method: Method;
	private _createConnection?: CreateConnectionFunction;
	private _cacheOptions: CacheOptions;
	private _httpsOptions: HttpsOptions;
	private _encoding?: BufferEncoding;
	private _resolveBodyOnly: boolean;
	private _isStream: boolean;
	private _responseType: ResponseType;
	private _pagination?: PaginationOptions<unknown, unknown, ErrorType>;

	constructor(urlOrOptions?: string | URL | OptionsInit, options?: OptionsInit) {
		this._request = undefined;
		this._agent = {};
		this._decompress = true;
		this._timeout = {};
		this._prefixUrl = '';
		this._body = undefined;
		this._form = undefined;
		this._json = undefined;
		this._cookieJar = undefined;
		this._ignoreInvalidCookies = false;
		this._searchParameters = undefined;
		this._dnsCache = undefined;
		this._context = {};
		this._hooks = {
			init: [],
			beforeRequest: [],
			beforeError: [],
			beforeRedirect: [],
			beforeRetry: [],
			afterResponse: []
		};
		this._followRedirect = true;
		this._maxRedirects = 10;
		this._cache = undefined;
		this._throwHttpErrors = true;
		this._username = '';
		this._password = '';
		this._http2 = false;
		this._allowGetBody = false;
		this._lookup = undefined;
		this._headers = {};
		this._methodRewriting = false;
		this._dnsLookupIpVersion = 'auto';
		this._parseJson = undefined;
		this._stringifyJson = undefined;
		this._retry = {
			limit: 2,
			methods: [
				'GET',
				'PUT',
				'HEAD',
				'DELETE',
				'OPTIONS',
				'TRACE'
			],
			statusCodes: [
				408,
				413,
				429,
				500,
				502,
				503,
				504,
				521,
				522,
				524
			],
			errorCodes: [
				'ETIMEDOUT',
				'ECONNRESET',
				'EADDRINUSE',
				'ECONNREFUSED',
				'EPIPE',
				'ENOTFOUND',
				'ENETUNREACH',
				'EAI_AGAIN'
			],
			maxRetryAfter: undefined,
			calculateDelay: ({computedValue}) => computedValue
		};
		this._localAddress = undefined;
		this._socketPath = undefined;
		this._method = 'GET';
		this._createConnection = undefined;
		this._cacheOptions = {};
		this._httpsOptions = {};
		this._encoding = undefined;
		this._resolveBodyOnly = false;
		this._isStream = false;
		this._responseType = 'text';

		assert.any([is.string, is.urlInstance, is.object, is.undefined], urlOrOptions);
		assert.any([is.object, is.undefined], options);

		if (is.plainObject(urlOrOptions)) {
			if (options) {
				throw new Error('There can be only one options argument');
			}

			options = urlOrOptions;
		} else if (urlOrOptions) {
			if (options?.url !== undefined) {
				throw new TypeError('The `url` option is mutually exclusive with the `input` argument');
			}

			this.url = urlOrOptions as (string | URL);
		}

		const initHooks = options?.hooks?.init;
		if (initHooks) {
			for (const hook of initHooks) {
				hook(options!);
			}
		}

		if (options) {
			for (const key in options) {
				if (!(key in this)) {
					throw new Error(`Key ${key} is not an option`);
				}

				// @ts-expect-error Type 'unknown' is not assignable to type 'never'.
				this[key as keyof Options] = options[key as keyof Options];
			}
		}
	}

	/**
	Custom request function.
	The main purpose of this is to [support HTTP2 using a wrapper](https://github.com/szmarczak/http2-wrapper).

	@default http.request | https.request
	*/
	get request(): RequestFunction | undefined {
		if (!this._request && this._url) {
			if (this._url.protocol === 'https:') {
				return requestHttps as RequestFunction;
			} else {
				return requestHttp as RequestFunction;
			}
		}

		return this._request;
	}

	set request(value: RequestFunction | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._request = value;
	}

	/**
	An object representing `http`, `https` and `http2` keys for [`http.Agent`](https://nodejs.org/api/http.html#http_class_http_agent), [`https.Agent`](https://nodejs.org/api/https.html#https_class_https_agent) and [`http2wrapper.Agent`](https://github.com/szmarczak/http2-wrapper#new-http2agentoptions) instance.
	This is necessary because a request to one protocol might redirect to another.
	In such a scenario, Got will switch over to the right protocol agent for you.

	If a key is not present, it will default to a global agent.

	@example
	```
	const got = require('got');
	const HttpAgent = require('agentkeepalive');
	const {HttpsAgent} = HttpAgent;

	got('https://sindresorhus.com', {
		agent: {
			http: new HttpAgent(),
			https: new HttpsAgent()
		}
	});
	```
	*/
	get agent(): Agents {
		return this._agent;
	}

	set agent(value: Agents) {
		assert.plainObject(value);

		for (const key in value) {
			if (key !== 'http' && key !== 'https' && key !== 'http2') {
				throw new TypeError(`Expected the \`options.agent\` properties to be \`http\`, \`https\` or \`http2\`, got \`${key}\``);
			}
		}

		this._agent = value;
	}

	/**
	Decompress the response automatically.
	This will set the `accept-encoding` header to `gzip, deflate, br` on Node.js 11.7.0+ or `gzip, deflate` for older Node.js versions, unless you set it yourself.

	Brotli (`br`) support requires Node.js 11.7.0 or later.

	If this is disabled, a compressed response is returned as a `Buffer`.
	This may be useful if you want to handle decompression yourself or stream the raw compressed data.

	@default true
	*/
	get decompress(): boolean {
		return this._decompress;
	}

	set decompress(value: boolean) {
		assert.boolean(value);

		this._decompress = value;
	}

	/**
	Milliseconds to wait for the server to end the response before aborting the request with `got.TimeoutError` error (a.k.a. `request` property).
	By default, there's no timeout.

	This also accepts an `object` with the following fields to constrain the duration of each phase of the request lifecycle:

	- `lookup` starts when a socket is assigned and ends when the hostname has been resolved.
		Does not apply when using a Unix domain socket.
	- `connect` starts when `lookup` completes (or when the socket is assigned if lookup does not apply to the request) and ends when the socket is connected.
	- `secureConnect` starts when `connect` completes and ends when the handshaking process completes (HTTPS only).
	- `socket` starts when the socket is connected. See [request.setTimeout](https://nodejs.org/api/http.html#http_request_settimeout_timeout_callback).
	- `response` starts when the request has been written to the socket and ends when the response headers are received.
	- `send` starts when the socket is connected and ends with the request has been written to the socket.
	- `request` starts when the request is initiated and ends when the response's end event fires.
	*/
	get timeout(): Delays | number {
		// We always return `Delays` here.
		// It has to be `Delays | number`, otherwise TypeScript will error because the getter and the setter have incompatible types.
		return this._timeout;
	}

	set timeout(value: Delays | number) {
		assert.any([is.plainObject, is.number], value);

		if (is.number(value)) {
			this._timeout.request = value;
		} else {
			this._timeout = {...value};
		}
	}

	/**
	When specified, `prefixUrl` will be prepended to `url`.
	The prefix can be any valid URL, either relative or absolute.
	A trailing slash `/` is optional - one will be added automatically.

	__Note__: `prefixUrl` will be ignored if the `url` argument is a URL instance.

	__Note__: Leading slashes in `input` are disallowed when using this option to enforce consistency and avoid confusion.
	For example, when the prefix URL is `https://example.com/foo` and the input is `/bar`, there's ambiguity whether the resulting URL would become `https://example.com/foo/bar` or `https://example.com/bar`.
	The latter is used by browsers.

	__Tip__: Useful when used with `got.extend()` to create niche-specific Got instances.

	__Tip__: You can change `prefixUrl` using hooks as long as the URL still includes the `prefixUrl`.
	If the URL doesn't include it anymore, it will throw.

	@example
	```
	const got = require('got');

	(async () => {
		await got('unicorn', {prefixUrl: 'https://cats.com'});
		//=> 'https://cats.com/unicorn'

		const instance = got.extend({
			prefixUrl: 'https://google.com'
		});

		await instance('unicorn', {
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = 'https://cats.com';
					}
				]
			}
		});
		//=> 'https://cats.com/unicorn'
	})();
	```
	*/
	get prefixUrl(): string | URL {
		// We always return `string` here.
		// It has to be `string | URL`, otherwise TypeScript will error because the getter and the setter have incompatible types.
		return this._prefixUrl;
	}

	set prefixUrl(value: string | URL) {
		assert.any([is.urlString, is.urlInstance], value);

		value = value.toString();

		if (value !== '' && !value.endsWith('/')) {
			value += '/';
		}

		if (this._prefixUrl && this._url) {
			const {href} = this.url as URL;

			if (!href.startsWith(value)) {
				throw new Error(`Cannot change \`prefixUrl\` from ${this._prefixUrl} to ${value}: ${href}`);
			}

			this._url = new URL(value + href.slice(this._prefixUrl.length));
			this._prefixUrl = value;
		}

		this._prefixUrl = value;
	}

	/**
	__Note #1__: The `body` option cannot be used with the `json` or `form` option.

	__Note #2__: If you provide this option, `got.stream()` will be read-only.

	__Note #3__: If you provide a payload with the `GET` or `HEAD` method, it will throw a `TypeError` unless the method is `GET` and the `allowGetBody` option is set to `true`.

	__Note #4__: This option is not enumerable and will not be merged with the instance defaults.

	The `content-length` header will be automatically set if `body` is a `string` / `Buffer` / `fs.createReadStream` instance / [`form-data` instance](https://github.com/form-data/form-data), and `content-length` and `transfer-encoding` are not manually set in `options.headers`.
	*/
	get body(): string | Buffer | Readable | undefined {
		return this._body;
	}

	set body(value: string | Buffer | Readable | undefined) {
		assert.any([is.string, is.buffer, is.nodeStream], value);

		if (is.nodeStream(value)) {
			assert.truthy(value.readable);
		}

		assert.undefined(this._form);
		assert.undefined(this._json);

		this._body = value;
	}

	/**
	The form body is converted to a query string using [`(new URLSearchParams(object)).toString()`](https://nodejs.org/api/url.html#url_constructor_new_urlsearchparams_obj).

	If the `Content-Type` header is not present, it will be set to `application/x-www-form-urlencoded`.

	__Note #1__: If you provide this option, `got.stream()` will be read-only.

	__Note #2__: This option is not enumerable and will not be merged with the instance defaults.
	*/
	get form(): Record<string, any> | undefined {
		return this._form;
	}

	set form(value: Record<string, any> | undefined) {
		assert.any([is.plainObject, is.undefined], value);
		assert.undefined(this._body);
		assert.undefined(this._json);

		this._form = value;
	}

	/**
	JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.

	__Note #1__: If you provide this option, `got.stream()` will be read-only.

	__Note #2__: This option is not enumerable and will not be merged with the instance defaults.
	*/
	get json(): Record<string, any> | undefined {
		return this._json;
	}

	set json(value: Record<string, any> | undefined) {
		assert.any([is.object, is.undefined], value);
		assert.undefined(this._body);
		assert.undefined(this._form);

		this._json = value;
	}

	/**
	The URL to request, as a string, a [`https.request` options object](https://nodejs.org/api/https.html#https_https_request_options_callback), or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url).

	Properties from `options` will override properties in the parsed `url`.

	If no protocol is specified, it will throw a `TypeError`.

	__Note__: The query string is **not** parsed as search params.

	@example
	```
	got('https://example.com/?query=a b'); //=> https://example.com/?query=a%20b
	got('https://example.com/', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b

	// The query string is overridden by `searchParams`
	got('https://example.com/?query=a b', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b
	```
	*/
	get url(): string | URL | undefined {
		return this._url;
	}

	set url(value: string | URL | undefined) {
		assert.any([is.string, is.urlInstance, is.undefined], value);

		if (is.undefined(value)) {
			this._url = undefined;
		} else {
			if (is.string(value) && value[0] === '/') {
				throw new Error('`url` must not start with a slash');
			}

			const urlString = `${this.prefixUrl}${value}`;
			this._url = new URL(urlString);
			decodeURI(urlString);

			if (this._url.protocol === 'unix:') {
				this._url.protocol = 'http:';

				this._url = new URL(`http://unix${this._url.pathname}${this._url.search}`);
			}

			if (this._url.protocol !== 'http:' && this._url.protocol !== 'https:') {
				throw new Error(`Unsupported protocol: ${this._url.protocol}`);
			}

			if (this._username) {
				this._url.username = this._username;
				this._username = '';
			}

			if (this._password) {
				this._url.password = this._password;
				this._password = '';
			}

			if (this._searchParameters) {
				this._url.search = this._searchParameters.toString();
				this._searchParameters = undefined;
			}
		}
	}

	/**
	Cookie support. You don't have to care about parsing or how to store them.

	__Note__: If you provide this option, `options.headers.cookie` will be overridden.
	*/
	get cookieJar(): PromiseCookieJar | ToughCookieJar | undefined {
		return this._cookieJar;
	}

	set cookieJar(value: PromiseCookieJar | ToughCookieJar | undefined) {
		assert.any([is.object, is.undefined], value);

		if (value) {
			let {setCookie, getCookieString} = value;

			assert.function_(setCookie);
			assert.function_(getCookieString);

			/* istanbul ignore next: Horrible `tough-cookie` v3 check */
			if (setCookie.length === 4 && getCookieString.length === 0) {
				setCookie = promisify(setCookie.bind(value));
				getCookieString = promisify(getCookieString.bind(value));

				this._cookieJar = {
					setCookie,
					getCookieString: getCookieString as PromiseCookieJar['getCookieString']
				};
			}
		} else {
			this._cookieJar = undefined;
		}
	}

	/**
	Ignore invalid cookies instead of throwing an error.
	Only useful when the `cookieJar` option has been set. Not recommended.

	@default false
	*/
	get ignoreInvalidCookies(): boolean {
		return this._ignoreInvalidCookies;
	}

	set ignoreInvalidCookies(value: boolean) {
		assert.boolean(value);

		this._ignoreInvalidCookies = value;
	}

	/**
	Query string that will be added to the request URL.
	This will override the query string in `url`.

	If you need to pass in an array, you can do it using a `URLSearchParams` instance.

	@example
	```
	const got = require('got');

	const searchParams = new URLSearchParams([['key', 'a'], ['key', 'b']]);

	got('https://example.com', {searchParams});

	console.log(searchParams.toString());
	//=> 'key=a&key=b'
	```
	*/
	get searchParameters(): string | Record<string, string | number | boolean | null | undefined> | URLSearchParams | undefined {
		if (this._url) {
			return this._url.searchParams;
		}

		return this._searchParameters;
	}

	set searchParameters(value: string | Record<string, string | number | boolean | null | undefined> | URLSearchParams | undefined) {
		assert.any([is.string, is.object, is.undefined]);

		if (value) {
			let searchParameters: URLSearchParams;

			if (is.string(value) || (value instanceof URLSearchParams)) {
				searchParameters = new URLSearchParams(value);
			} else {
				validateSearchParameters(value);

				searchParameters = new URLSearchParams();

				// eslint-disable-next-line guard-for-in
				for (const key in value) {
					const entry = value[key];

					if (entry === null) {
						searchParameters.append(key, '');
					} else if (entry !== undefined) {
						searchParameters.append(key, entry as string);
					}
				}
			}

			if (this._url) {
				this._url.search = searchParameters.toString();
			} else {
				this._searchParameters = searchParameters;
			}
		} else {
			this._searchParameters = undefined;

			if (this._url) {
				this._url.search = '';
			}
		}
	}

	/**
	An instance of [`CacheableLookup`](https://github.com/szmarczak/cacheable-lookup) used for making DNS lookups.
	Useful when making lots of requests to different *public* hostnames.

	`CacheableLookup` uses `dns.resolver4(..)` and `dns.resolver6(...)` under the hood and fall backs to `dns.lookup(...)` when the first two fail, which may lead to additional delay.

	__Note__: This should stay disabled when making requests to internal hostnames such as `localhost`, `database.local` etc.

	@default false
	*/
	get dnsCache(): CacheableLookup | boolean | undefined {
		return this._dnsCache;
	}

	set dnsCache(value: CacheableLookup | boolean | undefined) {
		assert.any([is.object, is.boolean, is.undefined], value);

		if (value === true) {
			this._dnsCache = globalDnsCache;
		} else if (value === false) {
			this._dnsCache = undefined;
		} else if (value instanceof CacheableLookup) {
			this._dnsCache = value;
		} else {
			throw new TypeError(`Parameter \`dnsCache\` must be a CacheableLookup instance or a boolean, got ${is(value)}`);
		}
	}

	/**
	User data. `context` is shallow merged and enumerable. If it contains non-enumerable properties they will NOT be merged.

	@example
	```
	const got = require('got');

	const instance = got.extend({
		hooks: {
			beforeRequest: [
				options => {
					if (!options.context || !options.context.token) {
						throw new Error('Token required');
					}

					options.headers.token = options.context.token;
				}
			]
		}
	});

	(async () => {
		const context = {
			token: 'secret'
		};

		const response = await instance('https://httpbin.org/headers', {context});

		// Let's see the headers
		console.log(response.body);
	})();
	```
	*/
	get context(): Record<string, unknown> {
		return this._context;
	}

	set context(value: Record<string, unknown>) {
		assert.object(value);

		this._context = {...value};
	}

	/**
	Hooks allow modifications during the request lifecycle.
	Hook functions may be async and are run serially.
	*/
	get hooks(): Hooks<ErrorType> | undefined {
		return this._hooks;
	}

	set hooks(value: Hooks<ErrorType> | undefined) {
		assert.any([is.object, is.undefined], value);

		const hooks: Hooks<ErrorType> = {
			init: [],
			beforeRetry: [],
			beforeRedirect: [],
			beforeError: [],
			beforeRequest: [],
			afterResponse: []
		};

		if (value) {
			for (const knownHookEvent in hooks) {
				if (knownHookEvent in value) {
					const specificHooks: Array<unknown> | undefined = value[knownHookEvent as keyof Hooks<ErrorType>];

					if (specificHooks) {
						assert.array(specificHooks);
					}

					hooks[knownHookEvent as keyof Hooks<ErrorType>] = [...specificHooks as any];
				}
			}
		}

		this._hooks = hooks;
	}

	/**
	Defines if redirect responses should be followed automatically.

	Note that if a `303` is sent by the server in response to any request type (`POST`, `DELETE`, etc.), Got will automatically request the resource pointed to in the location header via `GET`.
	This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4).

	@default true
	*/
	get followRedirect(): boolean {
		return this._followRedirect;
	}

	set followRedirect(value: boolean) {
		assert.boolean(value);

		this._followRedirect = value;
	}

	get followRedirects() {
		throw new TypeError('The `followRedirects` option does not exist. Use `followRedirect` instead.');
	}

	set followRedirects(_value: unknown) {
		throw new TypeError('The `followRedirects` option does not exist. Use `followRedirect` instead.');
	}

	/**
	If exceeded, the request will be aborted and a `MaxRedirectsError` will be thrown.

	@default 10
	*/
	get maxRedirects(): number {
		return this._maxRedirects;
	}

	set maxRedirects(value: number) {
		assert.number(value);

		this._maxRedirects = value;
	}

	/**
	A cache adapter instance for storing cached response data.

	@default false
	*/
	get cache(): string | CacheableRequest.StorageAdapter | false | undefined {
		return this._cache;
	}

	set cache(value: string | CacheableRequest.StorageAdapter | false | undefined) {
		assert.any([is.object, is.string, is.falsy, is.undefined], value);

		this._cache = value;
	}

	/**
	Determines if a `got.HTTPError` is thrown for unsuccessful responses.

	If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing.
	This may be useful if you are checking for resource availability and are expecting error responses.

	@default true
	*/
	get throwHttpErrors(): boolean {
		return this._throwHttpErrors;
	}

	set throwHttpErrors(value: boolean) {
		assert.boolean(value);

		this._throwHttpErrors = value;
	}

	get username(): string {
		if (this._url) {
			return this._url.username;
		}

		return this._username;
	}

	set username(value: string) {
		assert.string(value);

		if (this._url) {
			this._url.username = value;
		} else {
			this._username = value;
		}
	}

	get password(): string {
		if (this._url) {
			return this._url.password;
		}

		return this._password;
	}

	set password(value: string) {
		assert.string(value);

		if (this._url) {
			this._url.password = value;
		} else {
			this._password = value;
		}
	}

	/**
	If set to `true`, Got will additionally accept HTTP2 requests.

	It will choose either HTTP/1.1 or HTTP/2 depending on the ALPN protocol.

	__Note__: Overriding `options.request` will disable HTTP2 support.

	__Note__: This option will default to `true` in the next upcoming major release.

	@default false

	@example
	```
	const got = require('got');

	(async () => {
		const {headers} = await got('https://nghttp2.org/httpbin/anything', {http2: true});
		console.log(headers.via);
		//=> '2 nghttpx'
	})();
	```
	*/
	get http2(): boolean {
		return this._http2;
	}

	set http2(value: boolean) {
		assert.boolean(value);

		this._http2 = value;
	}

	/**
	Set this to `true` to allow sending body for the `GET` method.
	However, the [HTTP/2 specification](https://tools.ietf.org/html/rfc7540#section-8.1.3) says that `An HTTP GET request includes request header fields and no payload body`, therefore when using the HTTP/2 protocol this option will have no effect.
	This option is only meant to interact with non-compliant servers when you have no other choice.

	__Note__: The [RFC 7321](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore __it's considered an [anti-pattern](https://en.wikipedia.org/wiki/Anti-pattern)__.

	@default false
	*/
	get allowGetBody(): boolean {
		return this._allowGetBody;
	}

	set allowGetBody(value: boolean) {
		assert.boolean(value);

		this._allowGetBody = value;
	}

	get lookup(): CacheableLookup['lookup'] | undefined {
		return this._lookup;
	}

	set lookup(value: CacheableLookup['lookup'] | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._lookup = value;
	}

	/**
	Request headers.

	Existing headers will be overwritten. Headers set to `undefined` will be omitted.

	@default {}
	*/
	get headers(): Record<string, string> {
		return this._headers;
	}

	set headers(value: Record<string, string>) {
		assert.any([is.plainObject, is.undefined], value);

		this._headers = lowercaseKeys(value);
	}

	/**
	By default, [method rewriting](https://tools.ietf.org/html/rfc7231#section-6.4) is disabled.
	If enabled, when sending a POST request and receiving a `302` it will redirect using a `GET` method.

	@default false
	*/
	get methodRewriting(): boolean {
		return this._methodRewriting;
	}

	set methodRewriting(value: boolean) {
		assert.boolean(value);

		this._methodRewriting = value;
	}

	/**
	Indicates which DNS record family to use.

	Values:
	- `auto`: IPv4 (if present) or IPv6
	- `ipv4`: Only IPv4
	- `ipv6`: Only IPv6

	__Note__: If you are using the undocumented option `family`, `dnsLookupIpVersion` will override it.

	@default 'auto'
	*/
	get dnsLookupIpVersion(): DnsLookupIpVersion {
		return this._dnsLookupIpVersion;
	}

	set dnsLookupIpVersion(value: DnsLookupIpVersion) {
		assert.any([isDnsLookupIpVersion], value);

		this._dnsLookupIpVersion = value;
	}

	/**
	A function used to parse JSON responses.

	@example
	```
	const got = require('got');
	const Bourne = require('@hapi/bourne');

	(async () => {
		const parsed = await got('https://example.com', {
			parseJson: text => Bourne.parse(text)
		}).json();

		console.log(parsed);
	})();
	```
	*/
	get parseJson(): ParseJsonFunction | undefined {
		return this._parseJson;
	}

	set parseJson(value: ParseJsonFunction | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._parseJson = value;
	}

	/**
	A function used to stringify the body of JSON requests.

	@example
	```
	const got = require('got');

	(async () => {
		await got.post('https://example.com', {
			stringifyJson: object => JSON.stringify(object, (key, value) => {
				if (key.startsWith('_')) {
					return;
				}

				return value;
			}),
			json: {
				some: 'payload',
				_ignoreMe: 1234
			}
		});
	})();
	```

	@example
	```
	const got = require('got');

	(async () => {
		await got.post('https://example.com', {
			stringifyJson: object => JSON.stringify(object, (key, value) => {
				if (typeof value === 'number') {
					return value.toString();
				}

				return value;
			}),
			json: {
				some: 'payload',
				number: 1
			}
		});
	})();
	```
	*/
	get stringifyJson(): StringifyJsonFunction | undefined {
		return this._stringifyJson;
	}

	set stringifyJson(value: StringifyJsonFunction | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._stringifyJson = value;
	}

	/**
	An object representing `limit`, `calculateDelay`, `methods`, `statusCodes`, `maxRetryAfter` and `errorCodes` fields for maximum retry count, retry handler, allowed methods, allowed status codes, maximum [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) time and allowed error codes.

	Delays between retries counts with function `1000 * Math.pow(2, retry) + Math.random() * 100`, where `retry` is attempt number (starts from 1).

	The `calculateDelay` property is a `function` that receives an object with `attemptCount`, `retryOptions`, `error` and `computedValue` properties for current retry count, the retry options, error and default computed value.
	The function must return a delay in milliseconds (or a Promise resolving with it) (`0` return value cancels retry).

	By default, it retries *only* on the specified methods, status codes, and on these network errors:

	- `ETIMEDOUT`: One of the [timeout](#timeout) limits were reached.
	- `ECONNRESET`: Connection was forcibly closed by a peer.
	- `EADDRINUSE`: Could not bind to any free port.
	- `ECONNREFUSED`: Connection was refused by the server.
	- `EPIPE`: The remote side of the stream being written has been closed.
	- `ENOTFOUND`: Couldn't resolve the hostname to an IP address.
	- `ENETUNREACH`: No internet connection.
	- `EAI_AGAIN`: DNS lookup timed out.

	__Note__: If `maxRetryAfter` is set to `undefined`, it will use `options.timeout`.
	__Note__: If [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header is greater than `maxRetryAfter`, it will cancel the request.
	*/
	get retry(): RetryOptions | number {
		return this._retry;
	}

	set retry(value: RetryOptions | number) {
		assert.any([is.plainObject, is.number], value);

		if (is.number(value)) {
			this._retry.limit = value;
		} else {
			this._retry = {
				...this._retry,
				...value
			};

			this._retry.methods = [...new Set(this._retry.methods.map(method => method.toUpperCase() as Method))];
			this._retry.statusCodes = [...new Set(this._retry.statusCodes)];
			this._retry.errorCodes = [...new Set(this._retry.errorCodes)];
		}
	}

	// From `http.RequestOptions`
	/**
	The IP address used to send the request from.
	*/
	get localAddress(): string | undefined {
		return this._localAddress;
	}

	set localAddress(value: string | undefined) {
		assert.any([is.string, is.undefined], value);

		this._localAddress = value;
	}

	get socketPath(): string | undefined {
		return this._socketPath;
	}

	set socketPath(value: string | undefined) {
		assert.any([is.string, is.undefined], value);

		this._socketPath = value;
	}

	/**
	The HTTP method used to make the request.

	@default 'GET'
	*/
	get method(): Method {
		return this._method;
	}

	set method(value: Method) {
		assert.any([is.string, is.undefined], value);

		this._method = value.toUpperCase() as Method;
	}

	get createConnection(): CreateConnectionFunction | undefined {
		return this._createConnection;
	}

	set createConnection(value: CreateConnectionFunction | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._createConnection = value;
	}

	/**
	From `http-cache-semantics`

	@default {}
	*/
	get cacheOptions(): CacheOptions {
		return this._cacheOptions;
	}

	set cacheOptions(value: CacheOptions) {
		assert.any([is.plainObject, is.undefined], value);

		this._cacheOptions = {...value};
	}

	/**
	Options for the advanced HTTPS API.
	*/
	get httpsOptions(): HttpsOptions {
		return this._httpsOptions;
	}

	set httpsOptions(value: HttpsOptions) {
		assert.any([is.plainObject, is.undefined], value);

		if (value) {
			assert.any([is.boolean, is.undefined], value.rejectUnauthorized);
			assert.any([is.function_, is.undefined], value.checkServerIdentity);
			assert.any([is.string, is.object, is.array, is.undefined], value.certificateAuthority);
			assert.any([is.string, is.object, is.array, is.undefined], value.key);
			assert.any([is.string, is.object, is.array, is.undefined], value.certificate);
			assert.any([is.string, is.undefined], value.passphrase);
			assert.any([is.string, is.buffer, is.array, is.undefined], value.pfx);
		}

		this._httpsOptions = {...value};
	}

	get encoding(): BufferEncoding | undefined {
		return this._encoding;
	}

	set encoding(value: BufferEncoding | undefined) {
		if (is.null_(value)) {
			throw new TypeError('To get a Buffer, set `options.responseType` to `buffer` instead');
		}

		assert.any([is.string, is.undefined], value);

		this._encoding = value;
	}

	get resolveBodyOnly(): boolean {
		return this._resolveBodyOnly;
	}

	set resolveBodyOnly(value: boolean) {
		assert.boolean(value);

		this._resolveBodyOnly = value;
	}

	get isStream(): boolean {
		return this._isStream;
	}

	set isStream(value: boolean) {
		assert.boolean(value);

		this._isStream = value;
	}

	get responseType(): ResponseType {
		return this._responseType;
	}

	set responseType(value: ResponseType) {
		if (value !== 'text' && value !== 'buffer' && value !== 'json') {
			throw new Error(`Invalid \`responseType\` option: ${value}`);
		}

		this._responseType = value;
	}

	get pagination(): PaginationOptions<unknown, unknown, ErrorType> | undefined {
		return this._pagination;
	}

	set pagination(value: PaginationOptions<unknown, unknown, ErrorType> | undefined) {
		assert.any([is.object, is.undefined], value);

		const pagination: PaginationOptions<unknown, unknown, ErrorType> = {
			...this._pagination,
			...value
		};

		if (!is.function_(pagination.transform)) {
			throw new Error('`options.pagination.transform` must be implemented');
		}

		if (!is.function_(pagination.shouldContinue)) {
			throw new Error('`options.pagination.shouldContinue` must be implemented');
		}

		if (!is.function_(pagination.filter)) {
			throw new TypeError('`options.pagination.filter` must be implemented');
		}

		if (!is.function_(pagination.paginate)) {
			throw new Error('`options.pagination.paginate` must be implemented');
		}
	}

	set auth(_value: unknown) {
		throw new Error('Parameter `auth` is deprecated. Use `username` / `password` instead.');
	}

	get auth() {
		throw new Error('Parameter `auth` is deprecated. Use `username` / `password` instead.');
	}
}
