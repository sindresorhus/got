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
import {isResponseOk} from './utils/is-response-ok';
import deprecationWarning from '../utils/deprecation-warning';
import normalizePromiseArguments from '../as-promise/normalize-arguments';
import {PromiseOnly} from '../as-promise/types';
import calculateRetryDelay from './calculate-retry-delay';

let globalDnsCache: CacheableLookup;

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
const kRetryTimeout = Symbol('retryTimeout');
export const kIsNormalizedAlready = Symbol('isNormalizedAlready');

const supportsBrotli = is.string((process.versions as any).brotli);

export interface Agents {
	http?: http.Agent;
	https?: https.Agent;
	http2?: unknown;
}

export const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

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

/**
All available HTTP request methods provided by Got.
*/
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
export type BeforeRetryHook = (options: NormalizedOptions, error?: RequestError, retryCount?: number) => void | Promise<void>;

interface PlainHooks {
	/**
	Called with plain request options, right before their normalization.
	This is especially useful in conjunction with `got.extend()` when the input needs custom handling.

	__Note #1__: This hook must be synchronous!

	__Note #2__: Errors in this hook will be converted into an instances of `RequestError`.

	__Note #3__: The options object may not have a `url` property.
	To modify it, use a `beforeRequest` hook instead.

	@default []
	*/
	init?: InitHook[];

	/**
	Called with normalized request options.
	Got will make no further changes to the request before it is sent.
	This is especially useful in conjunction with `got.extend()` when you want to create an API client that, for example, uses HMAC-signing.

	@default []
	*/
	beforeRequest?: BeforeRequestHook[];

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
	beforeRedirect?: BeforeRedirectHook[];

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
	beforeError?: BeforeErrorHook[];

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
	beforeRetry?: BeforeRetryHook[];
}

/**
All available hook of Got.
*/
export interface Hooks extends PromiseOnly.Hooks, PlainHooks {}

type PlainHookEvent = 'init' | 'beforeRequest' | 'beforeRedirect' | 'beforeError' | 'beforeRetry';

/**
All hook events acceptable by Got.
*/
export type HookEvent = PromiseOnly.HookEvent | PlainHookEvent;

export const knownHookEvents: HookEvent[] = [
	'init',
	'beforeRequest',
	'beforeRedirect',
	'beforeError',
	'beforeRetry',

	// Promise-Only
	'afterResponse'
];

type AcceptableResponse = IncomingMessageWithTimings | ResponseLike;
type AcceptableRequestResult = AcceptableResponse | ClientRequest | Promise<AcceptableResponse | ClientRequest> | undefined;

export type RequestFunction = (url: URL, options: RequestOptions, callback?: (response: AcceptableResponse) => void) => AcceptableRequestResult;

export type Headers = Record<string, string | string[] | undefined>;

type CacheableRequestFunction = (
	options: string | URL | RequestOptions,
	cb?: (response: ServerResponse | ResponseLike) => void
) => CacheableRequest.Emitter;

type CheckServerIdentityFunction = (hostname: string, certificate: DetailedPeerCertificate) => Error | void;
export type ParseJsonFunction = (text: string) => unknown;
export type StringifyJsonFunction = (object: unknown) => string;

interface RealRequestOptions extends https.RequestOptions {
	checkServerIdentity: CheckServerIdentityFunction;
}

export interface RetryObject {
	attemptCount: number;
	retryOptions: RequiredRetryOptions;
	error: TimeoutError | RequestError;
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
export interface RequiredRetryOptions {
	limit: number;
	methods: Method[];
	statusCodes: number[];
	errorCodes: string[];
	calculateDelay: RetryFunction;
	maxRetryAfter?: number;
}

export interface CacheOptions {
	shared?: boolean;
	cacheHeuristic?: number;
	immutableMinTimeToLive?: number;
	ignoreCargoCult?: boolean;
}

interface PlainOptions extends URLOptions {
	/**
	Custom request function.
	The main purpose of this is to [support HTTP2 using a wrapper](https://github.com/szmarczak/http2-wrapper).

	@default http.request | https.request
	*/
	request?: RequestFunction;

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
	agent?: Agents | false;

	/**
	Decompress the response automatically.
	This will set the `accept-encoding` header to `gzip, deflate, br` on Node.js 11.7.0+ or `gzip, deflate` for older Node.js versions, unless you set it yourself.

	Brotli (`br`) support requires Node.js 11.7.0 or later.

	If this is disabled, a compressed response is returned as a `Buffer`.
	This may be useful if you want to handle decompression yourself or stream the raw compressed data.

	@default true
	*/
	decompress?: boolean;

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
	timeout?: Delays | number;

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
	prefixUrl?: string | URL;

	/**
	__Note #1__: The `body` option cannot be used with the `json` or `form` option.

	__Note #2__: If you provide this option, `got.stream()` will be read-only.

	__Note #3__: If you provide a payload with the `GET` or `HEAD` method, it will throw a `TypeError` unless the method is `GET` and the `allowGetBody` option is set to `true`.

	__Note #4__: This option is not enumerable and will not be merged with the instance defaults.

	The `content-length` header will be automatically set if `body` is a `string` / `Buffer` / `fs.createReadStream` instance / [`form-data` instance](https://github.com/form-data/form-data), and `content-length` and `transfer-encoding` are not manually set in `options.headers`.
	*/
	body?: string | Buffer | Readable;

	/**
	The form body is converted to a query string using [`(new URLSearchParams(object)).toString()`](https://nodejs.org/api/url.html#url_constructor_new_urlsearchparams_obj).

	If the `Content-Type` header is not present, it will be set to `application/x-www-form-urlencoded`.

	__Note #1__: If you provide this option, `got.stream()` will be read-only.

	__Note #2__: This option is not enumerable and will not be merged with the instance defaults.
	*/
	form?: Record<string, any>;

	/**
	JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.

	__Note #1__: If you provide this option, `got.stream()` will be read-only.

	__Note #2__: This option is not enumerable and will not be merged with the instance defaults.
	*/
	json?: Record<string, any>;

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
	url?: string | URL;

	/**
	Cookie support. You don't have to care about parsing or how to store them.

	__Note__: If you provide this option, `options.headers.cookie` will be overridden.
	*/
	cookieJar?: PromiseCookieJar | ToughCookieJar;

	/**
	Ignore invalid cookies instead of throwing an error.
	Only useful when the `cookieJar` option has been set. Not recommended.

	@default false
	*/
	ignoreInvalidCookies?: boolean;

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
	searchParams?: string | Record<string, string | number | boolean | null | undefined> | URLSearchParams;

	/**
	An instance of [`CacheableLookup`](https://github.com/szmarczak/cacheable-lookup) used for making DNS lookups.
	Useful when making lots of requests to different *public* hostnames.

	`CacheableLookup` uses `dns.resolver4(..)` and `dns.resolver6(...)` under the hood and fall backs to `dns.lookup(...)` when the first two fail, which may lead to additional delay.

	__Note__: This should stay disabled when making requests to internal hostnames such as `localhost`, `database.local` etc.

	@default false
	*/
	dnsCache?: CacheableLookup | boolean;

	/**
	User data. In contrast to other options, `context` is not enumerable.

	__Note__: The object is never merged, it's just passed through.
	Got will not modify the object in any way.

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
	context?: Record<string, unknown>;

	/**
	Hooks allow modifications during the request lifecycle.
	Hook functions may be async and are run serially.
	*/
	hooks?: Hooks;

	/**
	Defines if redirect responses should be followed automatically.

	Note that if a `303` is sent by the server in response to any request type (`POST`, `DELETE`, etc.), Got will automatically request the resource pointed to in the location header via `GET`.
	This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4).

	@default true
	*/
	followRedirect?: boolean;

	/**
	If exceeded, the request will be aborted and a `MaxRedirectsError` will be thrown.

	@default 10
	*/
	maxRedirects?: number;

	/**
	A cache adapter instance for storing cached response data.

	@default false
	*/
	cache?: string | CacheableRequest.StorageAdapter | false;

	/**
	Determines if a `got.HTTPError` is thrown for unsuccessful responses.

	If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing.
	This may be useful if you are checking for resource availability and are expecting error responses.

	@default true
	*/
	throwHttpErrors?: boolean;

	username?: string;

	password?: string;

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
	http2?: boolean;

	/**
	Set this to `true` to allow sending body for the `GET` method.
	However, the [HTTP/2 specification](https://tools.ietf.org/html/rfc7540#section-8.1.3) says that `An HTTP GET request includes request header fields and no payload body`, therefore when using the HTTP/2 protocol this option will have no effect.
	This option is only meant to interact with non-compliant servers when you have no other choice.

	__Note__: The [RFC 7321](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore __it's considered an [anti-pattern](https://en.wikipedia.org/wiki/Anti-pattern)__.

	@default false
	*/
	allowGetBody?: boolean;

	lookup?: CacheableLookup['lookup'];

	/**
	Request headers.

	Existing headers will be overwritten. Headers set to `undefined` will be omitted.

	@default {}
	*/
	headers?: Headers;

	/**
	By default, redirects will use [method rewriting](https://tools.ietf.org/html/rfc7231#section-6.4).
	For example, when sending a POST request and receiving a `302`, it will resend the body to the new location using the same HTTP method (`POST` in this case).

	@default true
	*/
	methodRewriting?: boolean;

	/**
	Indicates which DNS record family to use.

	Values:
	- `auto`: IPv4 (if present) or IPv6
	- `ipv4`: Only IPv4
	- `ipv6`: Only IPv6

	__Note__: If you are using the undocumented option `family`, `dnsLookupIpVersion` will override it.

	@default 'auto'
	*/
	dnsLookupIpVersion?: DnsLookupIpVersion;

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
	parseJson?: ParseJsonFunction;

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
	stringifyJson?: StringifyJsonFunction;

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
	retry?: Partial<RequiredRetryOptions> | number;

	// From `http.RequestOptions`
	/**
	The IP address used to send the request from.
	*/
	localAddress?: string;

	socketPath?: string;

	/**
	The HTTP method used to make the request.

	@default 'GET'
	*/
	method?: Method;

	createConnection?: (options: http.RequestOptions, oncreate: (error: Error, socket: Socket) => void) => Socket;

	// From `http-cache-semantics`
	cacheOptions?: CacheOptions;

	// TODO: remove when Got 12 gets released
	/**
	If set to `false`, all invalid SSL certificates will be ignored and no error will be thrown.

	If set to `true`, it will throw an error whenever an invalid SSL certificate is detected.

	We strongly recommend to have this set to `true` for security reasons.

	@default true

	@example
	```
	const got = require('got');

	(async () => {
		// Correct:
		await got('https://example.com', {rejectUnauthorized: true});

		// You can disable it when developing an HTTPS app:
		await got('https://localhost', {rejectUnauthorized: false});

		// Never do this:
		await got('https://example.com', {rejectUnauthorized: false});
	})();
	```
	*/
	rejectUnauthorized?: boolean; // Here for backwards compatibility

	/**
	Options for the advanced HTTPS API.
	*/
	https?: HTTPSOptions;
}

export interface Options extends PromiseOnly.Options, PlainOptions {}

export interface HTTPSOptions {
	// From `http.RequestOptions` and `tls.CommonConnectionOptions`
	rejectUnauthorized?: https.RequestOptions['rejectUnauthorized'];

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
	retry: RequiredRetryOptions;
	cacheOptions: CacheOptions;
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
	retry: RequiredRetryOptions;

	// Optional
	agent?: Agents | false;
	request?: RequestFunction;
	searchParams?: URLSearchParams;
	lookup?: CacheableLookup['lookup'];
	localAddress?: string;
	createConnection?: Options['createConnection'];

	// From `http-cache-semantics`
	cacheOptions: CacheOptions;
}

export interface Defaults extends PromiseOnly.Defaults, PlainDefaults {}

export interface Progress {
	percent: number;
	transferred: number;
	total?: number;
}

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

export interface RequestEvents<T> {
	/**
	`request` event to get the request object of the request.

	 __Tip__: You can use `request` event to abort requests.

	@example
	```
	got.stream('https://github.com')
		.on('request', request => setTimeout(() => request.destroy(), 50));
	```
	*/
	on: ((name: 'request', listener: (request: http.ClientRequest) => void) => T)

	/**
	The `response` event to get the response object of the final request.
	*/
	& (<R extends Response>(name: 'response', listener: (response: R) => void) => T)

	/**
	The `redirect` event to get the response object of a redirect. The second argument is options for the next request to the redirect location.
	*/
	& (<R extends Response, N extends NormalizedOptions>(name: 'redirect', listener: (response: R, nextOptions: N) => void) => T)

	/**
	Progress events for uploading (sending a request) and downloading (receiving a response).
	The `progress` argument is an object like:

	```js
	{
		percent: 0.1,
		transferred: 1024,
		total: 10240
	}
	```

	If the `content-length` header is missing, `total` will be `undefined`.

	@example
	```js
	(async () => {
		const response = await got('https://sindresorhus.com')
			.on('downloadProgress', progress => {
				// Report download progress
			})
			.on('uploadProgress', progress => {
				// Report upload progress
			});

		console.log(response);
	})();
	```
	*/
	& ((name: 'uploadProgress' | 'downloadProgress', listener: (progress: Progress) => void) => T)
	/**
	To enable retrying on a Got stream, it is required to have a `retry` handler attached.

	When this event is emitted, you should reset the stream you were writing to and prepare the body again.

	See `got.options.retry` for more information.
	*/
	& ((name: 'retry', listener: (retryCount: number, error: RequestError) => void) => T);
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

/**
An error to be thrown when a request fails.
Contains a `code` property with error class code, like `ECONNREFUSED`.
*/
export class RequestError extends Error {
	code: string;
	stack!: string;
	declare readonly options: NormalizedOptions;
	readonly response?: Response;
	readonly request?: Request;
	readonly timings?: Timings;

	constructor(message: string, error: Partial<Error & {code?: string}>, self: Request | NormalizedOptions) {
		super(message);
		Error.captureStackTrace(this, this.constructor);

		this.name = 'RequestError';
		this.code = error.code ?? 'ERR_GOT_REQUEST_ERROR';

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
		if (is.string(error.stack) && is.string(this.stack)) {
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

/**
An error to be thrown when the server redirects you more than ten times.
Includes a `response` property.
*/
export class MaxRedirectsError extends RequestError {
	declare readonly response: Response;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(request: Request) {
		super(`Redirected ${request.options.maxRedirects} times. Aborting.`, {}, request);
		this.name = 'MaxRedirectsError';
		this.code = 'ERR_TOO_MANY_REDIRECTS';
	}
}

/**
An error to be thrown when the server response code is not 2xx nor 3xx if `options.followRedirect` is `true`, but always except for 304.
Includes a `response` property.
*/
export class HTTPError extends RequestError {
	declare readonly response: Response;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(response: Response) {
		super(`Response code ${response.statusCode} (${response.statusMessage!})`, {}, response.request);
		this.name = 'HTTPError';
		this.code = 'ERR_NON_2XX_3XX_RESPONSE';
	}
}
/**
An error to be thrown when a cache method fails.
For example, if the database goes down or there's a filesystem error.
*/
export class CacheError extends RequestError {
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'CacheError';
		this.code = this.code === 'ERR_GOT_REQUEST_ERROR' ? 'ERR_CACHE_ACCESS' : this.code;
	}
}

/**
An error to be thrown when the request body is a stream and an error occurs while reading from that stream.
*/
export class UploadError extends RequestError {
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'UploadError';
		this.code = this.code === 'ERR_GOT_REQUEST_ERROR' ? 'ERR_UPLOAD' : this.code;
	}
}

/**
An error to be thrown when the request is aborted due to a timeout.
Includes an `event` and `timings` property.
*/
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

/**
An error to be thrown when reading from response stream fails.
*/
export class ReadError extends RequestError {
	declare readonly request: Request;
	declare readonly response: Response;
	declare readonly timings: Timings;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'ReadError';
		this.code = this.code === 'ERR_GOT_REQUEST_ERROR' ? 'ERR_READING_RESPONSE_STREAM' : this.code;
	}
}

/**
An error to be thrown when given an unsupported protocol.
*/
export class UnsupportedProtocolError extends RequestError {
	constructor(options: NormalizedOptions) {
		super(`Unsupported protocol "${options.url.protocol}"`, {}, options);
		this.name = 'UnsupportedProtocolError';
		this.code = 'ERR_UNSUPPORTED_PROTOCOL';
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
	[kRetryTimeout]?: NodeJS.Timeout;
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
	retryCount: number;

	constructor(url: string | URL | undefined, options: Options = {}, defaults?: Defaults) {
		super({
			// This must be false, to enable throwing after destroy
			// It is used for retry logic in Promise API
			autoDestroy: false,
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
		this.retryCount = 0;

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

		if (kIsNormalizedAlready in options) {
			this.options = options as NormalizedOptions;
		} else {
			try {
				// @ts-expect-error Common TypeScript bug saying that `this.constructor` is not accessible
				this.options = this.constructor.normalizeArguments(url, options, defaults);
			} catch (error) {
				// TODO: Move this to `_destroy()`
				if (is.nodeStream(options.body)) {
					options.body.destroy();
				}

				this.destroy(error);
				return;
			}
		}

		(async () => {
			try {
				if (this.options.body instanceof ReadStream) {
					await waitForOpenFile(this.options.body);
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

				// Prevent memory leak
				this[kJobs].length = 0;

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
		})();
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
			assert.any([is.string, is.buffer, is.array, is.undefined], options.https.pfx);
		}

		assert.any([is.object, is.undefined], options.cacheOptions);

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
		if (is.undefined(options.prefixUrl)) {
			options.prefixUrl = defaults?.prefixUrl ?? '';
		} else {
			options.prefixUrl = options.prefixUrl.toString();

			if (options.prefixUrl !== '' && !options.prefixUrl.endsWith('/')) {
				options.prefixUrl += '/';
			}
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
			if ('port' in options) {
				delete options.port;
			}

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
					getCookieString: getCookieString as PromiseCookieJar['getCookieString']
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

		// `options.cacheOptions`
		options.cacheOptions = {...options.cacheOptions};

		// `options.dnsCache`
		if (options.dnsCache === true) {
			if (!globalDnsCache) {
				globalDnsCache = new CacheableLookup();
			}

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

				if (defaultHooks.length > 0) {
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

		if ('pfx' in options) {
			deprecationWarning('"options.pfx" was never documented, please use "options.https.pfx"');
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

		return normalizePromiseArguments(options as NormalizedOptions, defaults);
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
		typedResponse.retryCount = this.retryCount;

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
			// It'd be best to abort the request, but we can't because
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

				this[kBody] = undefined;
				delete options.headers['content-length'];
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
				if (redirectUrl.hostname !== url.hostname || redirectUrl.port !== url.port) {
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
						options.username = '';
						options.password = '';
					}
				} else {
					redirectUrl.username = options.username;
					redirectUrl.password = options.password;
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

		if (options.isStream && options.throwHttpErrors && !isResponseOk(typedResponse)) {
			this._beforeError(new HTTPError(typedResponse));
			return;
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
			/* istanbul ignore next: better safe than sorry */
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

			error = error instanceof TimedOutTimeoutError ? new TimeoutError(error, this.timings!, this) : new RequestError(error.message, error, this);

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
			// TODO: Fix this ignore.
			// @ts-expect-error
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

		if (options.body && this[kBody] !== options.body) {
			this[kBody] = options.body;
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
		// TODO: Fix this ignore.
		// @ts-expect-error
		delete options.timeout;

		const requestOptions = options as unknown as (RealRequestOptions & CacheOptions);
		requestOptions.shared = options.cacheOptions?.shared;
		requestOptions.cacheHeuristic = options.cacheOptions?.cacheHeuristic;
		requestOptions.immutableMinTimeToLive = options.cacheOptions?.immutableMinTimeToLive;
		requestOptions.ignoreCargoCult = options.cacheOptions?.ignoreCargoCult;

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

			if (options.https.pfx) {
				requestOptions.pfx = options.https.pfx;
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

			// HTTPS options restore
			if (options.https) {
				if ('rejectUnauthorized' in options.https) {
					delete requestOptions.rejectUnauthorized;
				}

				if (options.https.checkServerIdentity) {
					// @ts-expect-error - This one will be removed when we remove the alias.
					delete requestOptions.checkServerIdentity;
				}

				if (options.https.certificateAuthority) {
					delete requestOptions.ca;
				}

				if (options.https.certificate) {
					delete requestOptions.cert;
				}

				if (options.https.key) {
					delete requestOptions.key;
				}

				if (options.https.passphrase) {
					delete requestOptions.passphrase;
				}

				if (options.https.pfx) {
					delete requestOptions.pfx;
				}
			}

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

	async _error(error: RequestError): Promise<void> {
		try {
			for (const hook of this.options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}
		} catch (error_) {
			error = new RequestError(error_.message, error_, this);
		}

		this.destroy(error);
	}

	_beforeError(error: Error): void {
		if (this[kStopReading]) {
			return;
		}

		const {options} = this;
		const retryCount = this.retryCount + 1;

		this[kStopReading] = true;

		if (!(error instanceof RequestError)) {
			error = new RequestError(error.message, error, this);
		}

		const typedError = error as RequestError;
		const {response} = typedError;

		void (async () => {
			if (response && !response.body) {
				response.setEncoding((this as any)._readableState.encoding);

				try {
					response.rawBody = await getBuffer(response);
					response.body = response.rawBody.toString();
				} catch {}
			}

			if (this.listenerCount('retry') !== 0) {
				let backoff: number;

				try {
					let retryAfter;
					if (response && 'retry-after' in response.headers) {
						retryAfter = Number(response.headers['retry-after']);
						if (Number.isNaN(retryAfter)) {
							retryAfter = Date.parse(response.headers['retry-after']!) - Date.now();

							if (retryAfter <= 0) {
								retryAfter = 1;
							}
						} else {
							retryAfter *= 1000;
						}
					}

					backoff = await options.retry.calculateDelay({
						attemptCount: retryCount,
						retryOptions: options.retry,
						error: typedError,
						retryAfter,
						computedValue: calculateRetryDelay({
							attemptCount: retryCount,
							retryOptions: options.retry,
							error: typedError,
							retryAfter,
							computedValue: 0
						})
					});
				} catch (error_) {
					void this._error(new RequestError(error_.message, error_, this));
					return;
				}

				if (backoff) {
					const retry = async (): Promise<void> => {
						try {
							for (const hook of this.options.hooks.beforeRetry) {
								// eslint-disable-next-line no-await-in-loop
								await hook(this.options, typedError, retryCount);
							}
						} catch (error_) {
							void this._error(new RequestError(error_.message, error, this));
							return;
						}

						// Something forced us to abort the retry
						if (this.destroyed) {
							return;
						}

						this.destroy();
						this.emit('retry', retryCount, error);
					};

					this[kRetryTimeout] = setTimeout(retry, backoff);
					return;
				}
			}

			void this._error(typedError);
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
		if (this[kRequest]!.destroyed) {
			// Probably the `ClientRequest` instance will throw
			return;
		}

		this._progressCallbacks.push((): void => {
			this[kUploadedSize] += Buffer.byteLength(chunk, encoding);

			const progress = this.uploadProgress;

			if (progress.percent < 1) {
				this.emit('uploadProgress', progress);
			}
		});

		// TODO: What happens if it's from cache? Then this[kRequest] won't be defined.

		this[kRequest]!.write(chunk, encoding!, (error?: Error | null) => {
			if (!error && this._progressCallbacks.length > 0) {
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

		// Prevent further retries
		clearTimeout(this[kRetryTimeout] as NodeJS.Timeout);

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

	get _isAboutToError() {
		return this[kStopReading];
	}

	/**
	The remote IP address.
	*/
	get ip(): string | undefined {
		return this.socket?.remoteAddress;
	}

	/**
	Indicates whether the request has been aborted or not.
	*/
	get aborted(): boolean {
		return (this[kRequest]?.destroyed ?? this.destroyed) && !(this[kOriginalResponse]?.complete);
	}

	get socket(): Socket | undefined {
		return this[kRequest]?.socket ?? undefined;
	}

	/**
	Progress event for downloading (receiving a response).
	*/
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

	/**
	Progress event for uploading (sending a request).
	*/
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
	get timings(): Timings | undefined {
		return (this[kRequest] as ClientRequestWithTimings)?.timings;
	}

	/**
	Whether the response was retrieved from the cache.
	*/
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
