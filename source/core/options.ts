import {promisify, inspect} from 'util';
import {URL, URLSearchParams} from 'url';
import {checkServerIdentity} from 'tls';
import {request as httpRequest} from 'http';
import {request as httpsRequest} from 'https';
import type {Readable} from 'stream';
import type {Socket} from 'net';
import type {SecureContextOptions, DetailedPeerCertificate} from 'tls';
import type {
	Agent as HttpAgent,
	ClientRequest,
} from 'http';
import type {
	RequestOptions as HttpsRequestOptions,
	Agent as HttpsAgent,
} from 'https';
import type {InspectOptions} from 'util';
import is, {assert} from '@sindresorhus/is';
import lowercaseKeys from 'lowercase-keys';
import CacheableLookup from 'cacheable-lookup';
import http2wrapper, {ClientHttp2Session} from 'http2-wrapper';
import type CacheableRequest from 'cacheable-request';
import type ResponseLike from 'responselike';
import type {IncomingMessageWithTimings} from '@szmarczak/http-timer';
import type {CancelableRequest} from '../as-promise/types.js';
import parseLinkHeader from './parse-link-header.js';
import type {PlainResponse, Response} from './response.js';
import type {RequestError} from './errors.js';
import type {Delays} from './timed-out.js';

type Promisable<T> = T | Promise<T>;

const [major, minor] = process.versions.node.split('.').map(v => Number(v)) as [number, number, number];

export type DnsLookupIpVersion = undefined | 4 | 6;

type Except<ObjectType, KeysType extends keyof ObjectType> = Pick<ObjectType, Exclude<keyof ObjectType, KeysType>>;

export type NativeRequestOptions = HttpsRequestOptions & CacheOptions & {checkServerIdentity?: CheckServerIdentityFunction};

type AcceptableResponse = IncomingMessageWithTimings | ResponseLike;
type AcceptableRequestResult = Promisable<AcceptableResponse | ClientRequest> | undefined;
export type RequestFunction = (url: URL, options: NativeRequestOptions, callback?: (response: AcceptableResponse) => void) => AcceptableRequestResult;

export interface Agents {
	http?: HttpAgent | false;
	https?: HttpsAgent | false;
	http2?: unknown | false;
}

export type Headers = Record<string, string | string[] | undefined>;

export interface ToughCookieJar {
	getCookieString: ((currentUrl: string, options: Record<string, unknown>, cb: (error: Error | null, cookies: string) => void) => void)
	& ((url: string, callback: (error: Error | null, cookieHeader: string) => void) => void);
	setCookie: ((cookieOrString: unknown, currentUrl: string, options: Record<string, unknown>, cb: (error: Error | null, cookie: unknown) => void) => void)
	& ((rawCookie: string, url: string, callback: (error: Error | null, result: unknown) => void) => void);
}

export interface PromiseCookieJar {
	getCookieString: (url: string) => Promise<string>;
	setCookie: (rawCookie: string, url: string) => Promise<unknown>;
}

export type InitHook = (init: OptionsInit, self: Options) => void;
export type BeforeRequestHook = (options: Options) => Promisable<void | Response | ResponseLike>;
export type BeforeRedirectHook = (updatedOptions: Options, plainResponse: PlainResponse) => Promisable<void>;
export type BeforeErrorHook = (error: RequestError) => Promisable<RequestError>;
export type BeforeRetryHook = (error: RequestError, retryCount: number) => Promisable<void>;
export type AfterResponseHook<ResponseType = unknown> = (response: Response<ResponseType>, retryWithMergedOptions: (options: OptionsInit) => never) => Promisable<Response | CancelableRequest<Response>>;

/**
All available hooks of Got.
*/
export interface Hooks {
	/**
	Called with plain request options, right before their normalization.
	This is especially useful in conjunction with `got.extend()` when the input needs custom handling.

	__Note #1__: This hook must be synchronous!

	__Note #2__: Errors in this hook will be converted into an instances of `RequestError`.

	__Note #3__: The options object may not have a `url` property.
	To modify it, use a `beforeRequest` hook instead.

	@default []
	*/
	init: InitHook[];

	/**
	Called with normalized request options.
	Got will make no further changes to the request before it is sent.
	This is especially useful in conjunction with `got.extend()` when you want to create an API client that, for example, uses HMAC-signing.

	@default []
	*/
	beforeRequest: BeforeRequestHook[];

	/**
	Called with normalized request options and the redirect response.
	Got will make no further changes to the request.
	This is especially useful when you want to avoid dead sites.

	@default []

	@example
	```
	import got from 'got';

	await got('https://example.com', {
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
	beforeRedirect: BeforeRedirectHook[];

	/**
	Called with an `Error` instance.
	The error is passed to the hook right before it's thrown.
	This is especially useful when you want to have more detailed errors.

	__Note__: Errors thrown while normalizing input options are thrown directly and not part of this hook.

	@default []

	@example
	```
	import got from 'got';

	await got('https://api.github.com/some-endpoint', {
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
	beforeError: BeforeErrorHook[];

	/**
	Called with normalized request options, the error and the retry count.
  Got will make no further changes to the request.
	This is especially useful when some extra work is required before the next try.

	__Note__: When using streams, this hook is ignored.
	__Note__: When retrying in a `afterResponse` hook, all remaining `beforeRetry` hooks will be called without the `error` and `retryCount` arguments.

	@default []

	@example
	```
	import got from 'got';

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
	beforeRetry: BeforeRetryHook[];

	/**
	Called with [response object](#response) and a retry function.
	Calling the retry function will trigger `beforeRetry` hooks.

	Each function should return the response.
	This is especially useful when you want to refresh an access token.

	__Note__: When using streams, this hook is ignored.

	@example
	```
	import got from 'got';

	const instance = got.extend({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) { // Unauthorized
						const updatedOptions = {
							headers: {
								token: getNewToken() // Refresh the access token
							}
						};

						// Save for further requests
						instance.defaults.options = got.mergeOptions(instance.defaults.options, updatedOptions);

						// Make a new retry
						return retryWithMergedOptions(updatedOptions);
					}

					// No changes otherwise
					return response;
				}
			],
			beforeRetry: [
				(options, error, retryCount) => {
					// This will be called on `retryWithMergedOptions(...)`
				}
			]
		},
		mutableDefaults: true
	});
	```
	*/
	afterResponse: AfterResponseHook[];
}

export type ParseJsonFunction = (text: string) => unknown;
export type StringifyJsonFunction = (object: unknown) => string;

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

export interface RetryObject {
	attemptCount: number;
	retryOptions: RetryOptions;
	error: RequestError;
	computedValue: number;
	retryAfter?: number;
}

export type RetryFunction = (retryObject: RetryObject) => Promisable<number>;

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

__Note:__ Got does not retry on `POST` by default.
__Note:__ If `maxRetryAfter` is set to `undefined`, it will use `options.timeout`.
__Note:__ If [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header is greater than `maxRetryAfter`, it will cancel the request.
*/
export interface RetryOptions {
	limit: number;
	methods: Method[];
	statusCodes: number[];
	errorCodes: string[];
	calculateDelay: RetryFunction;
	backoffLimit: number;
	noise: number;
	maxRetryAfter?: number;
}

export type CreateConnectionFunction = (options: NativeRequestOptions, oncreate: (error: NodeJS.ErrnoException, socket: Socket) => void) => Socket;
export type CheckServerIdentityFunction = (hostname: string, certificate: DetailedPeerCertificate) => NodeJS.ErrnoException | void;

export interface CacheOptions {
	shared?: boolean;
	cacheHeuristic?: number;
	immutableMinTimeToLive?: number;
	ignoreCargoCult?: boolean;
}

type PfxObject = {
	buffer: string | Buffer;
	passphrase?: string | undefined;
};

type PfxType = string | Buffer | Array<string | Buffer | PfxObject> | undefined;

export interface HttpsOptions {
	alpnProtocols?: string[];

	// From `http.RequestOptions` and `tls.CommonConnectionOptions`
	rejectUnauthorized?: NativeRequestOptions['rejectUnauthorized'];

	// From `tls.ConnectionOptions`
	checkServerIdentity?: CheckServerIdentityFunction;

	// From `tls.SecureContextOptions`
	/**
	Override the default Certificate Authorities ([from Mozilla](https://ccadb-public.secure.force.com/mozilla/IncludedCACertificateReport)).

	@example
	```
	// Single Certificate Authority
	await got('https://example.com', {
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
	pfx?: PfxType;

	ciphers?: SecureContextOptions['ciphers'];
	honorCipherOrder?: SecureContextOptions['honorCipherOrder'];
	minVersion?: SecureContextOptions['minVersion'];
	maxVersion?: SecureContextOptions['maxVersion'];
	signatureAlgorithms?: SecureContextOptions['sigalgs'];
	tlsSessionLifetime?: SecureContextOptions['sessionTimeout'];
	dhparam?: SecureContextOptions['dhparam'];
	ecdhCurve?: SecureContextOptions['ecdhCurve'];
	certificateRevocationLists?: SecureContextOptions['crl'];
}

export interface PaginateData<BodyType, ElementType> {
	response: Response<BodyType>;
	currentItems: ElementType[];
	allItems: ElementType[];
}

export interface FilterData<ElementType> {
	item: ElementType;
	currentItems: ElementType[];
	allItems: ElementType[];
}

/**
All options accepted by `got.paginate()`.
*/
export interface PaginationOptions<ElementType, BodyType> {
	/**
	A function that transform [`Response`](#response) into an array of items.
	This is where you should do the parsing.

	@default response => JSON.parse(response.body)
	*/
	transform?: (response: Response<BodyType>) => Promise<ElementType[]> | ElementType[];

	/**
	Checks whether the item should be emitted or not.

	@default ({item, currentItems, allItems}) => true
	*/
	filter?: (data: FilterData<ElementType>) => boolean;

	/**
	The function takes an object with the following properties:
	- `response` - The current response object.
	- `currentItems` - Items from the current response.
	- `allItems` - An empty array, unless `pagination.stackAllItems` is set to `true`, in which case, it's an array of the emitted items.

	It should return an object representing Got options pointing to the next page. The options are merged automatically with the previous request, therefore the options returned `pagination.paginate(...)` must reflect changes only. If there are no more pages, `false` should be returned.

	@example
	```
	import got from 'got';

	const limit = 10;

	const items = got.paginate('https://example.com/items', {
		searchParams: {
			limit,
			offset: 0
		},
		pagination: {
			paginate: ({response, currentItems}) => {
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
	```
	*/
	paginate?: (data: PaginateData<BodyType, ElementType>) => OptionsInit | false;

	/**
	Checks whether the pagination should continue.

	For example, if you need to stop **before** emitting an entry with some flag, you should use `({item}) => !item.flag`.

	If you want to stop **after** emitting the entry, you should use
	`({item, allItems}) => allItems.some(item => item.flag)` instead.

	@default ({item, currentItems, allItems}) => true
	*/
	shouldContinue?: (data: FilterData<ElementType>) => boolean;

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
	Defines how the property `allItems` in `pagination.paginate`, `pagination.filter` and `pagination.shouldContinue` is managed.

	By default, the property `allItems` is always an empty array. This setting can be helpful to save on memory usage when working with a large dataset.

	When set to `true`, the property `allItems` is an array of the emitted items.

	@default false
	*/
	stackAllItems?: boolean;
}

export type SearchParameters = Record<string, string | number | boolean | null | undefined>;

function validateSearchParameters(searchParameters: Record<string, unknown>): asserts searchParameters is Record<string, string | number | boolean | null | undefined> {
	// eslint-disable-next-line guard-for-in
	for (const key in searchParameters) {
		const value = searchParameters[key];

		assert.any([is.string, is.number, is.boolean, is.null_, is.undefined], value);
	}
}

/**
All parsing methods supported by Got.
*/
export type ResponseType = 'json' | 'buffer' | 'text';

type OptionsToSkip =
	'searchParameters' |
	'followRedirects' |
	'auth' |
	'toJSON' |
	'merge' |
	'createNativeRequestOptions' |
	'getRequestFunction' |
	'getFallbackRequestFunction' |
	'freeze';

export type InternalsType = Except<Options, OptionsToSkip>;

export type OptionsError = NodeJS.ErrnoException & {options?: Options};

export type OptionsInit =
	Except<Partial<InternalsType>, 'hooks' | 'retry'>
	& {
		hooks?: Partial<Hooks>;
		retry?: Partial<RetryOptions>;
	};

const globalCache = new Map();
let globalDnsCache: CacheableLookup;

const getGlobalDnsCache = (): CacheableLookup => {
	if (globalDnsCache) {
		return globalDnsCache;
	}

	globalDnsCache = new CacheableLookup();
	return globalDnsCache;
};

const defaultInternals: Options['_internals'] = {
	request: undefined,
	agent: {
		http: undefined,
		https: undefined,
		http2: undefined,
	},
	h2session: undefined,
	decompress: true,
	timeout: {
		connect: undefined,
		lookup: undefined,
		read: undefined,
		request: undefined,
		response: undefined,
		secureConnect: undefined,
		send: undefined,
		socket: undefined,
	},
	prefixUrl: '',
	body: undefined,
	form: undefined,
	json: undefined,
	cookieJar: undefined,
	ignoreInvalidCookies: false,
	searchParams: undefined,
	dnsLookup: undefined,
	dnsCache: undefined,
	context: {},
	hooks: {
		init: [],
		beforeRequest: [],
		beforeError: [],
		beforeRedirect: [],
		beforeRetry: [],
		afterResponse: [],
	},
	followRedirect: true,
	maxRedirects: 10,
	cache: undefined,
	throwHttpErrors: true,
	username: '',
	password: '',
	http2: false,
	allowGetBody: false,
	headers: {
		'user-agent': 'got (https://github.com/sindresorhus/got)',
	},
	methodRewriting: false,
	dnsLookupIpVersion: undefined,
	parseJson: JSON.parse,
	stringifyJson: JSON.stringify,
	retry: {
		limit: 2,
		methods: [
			'GET',
			'PUT',
			'HEAD',
			'DELETE',
			'OPTIONS',
			'TRACE',
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
			524,
		],
		errorCodes: [
			'ETIMEDOUT',
			'ECONNRESET',
			'EADDRINUSE',
			'ECONNREFUSED',
			'EPIPE',
			'ENOTFOUND',
			'ENETUNREACH',
			'EAI_AGAIN',
		],
		maxRetryAfter: undefined,
		calculateDelay: ({computedValue}) => computedValue,
		backoffLimit: Number.POSITIVE_INFINITY,
		noise: 100,
	},
	localAddress: undefined,
	method: 'GET',
	createConnection: undefined,
	cacheOptions: {
		shared: undefined,
		cacheHeuristic: undefined,
		immutableMinTimeToLive: undefined,
		ignoreCargoCult: undefined,
	},
	https: {
		alpnProtocols: undefined,
		rejectUnauthorized: undefined,
		checkServerIdentity: undefined,
		certificateAuthority: undefined,
		key: undefined,
		certificate: undefined,
		passphrase: undefined,
		pfx: undefined,
		ciphers: undefined,
		honorCipherOrder: undefined,
		minVersion: undefined,
		maxVersion: undefined,
		signatureAlgorithms: undefined,
		tlsSessionLifetime: undefined,
		dhparam: undefined,
		ecdhCurve: undefined,
		certificateRevocationLists: undefined,
	},
	encoding: undefined,
	resolveBodyOnly: false,
	isStream: false,
	responseType: 'text',
	url: undefined,
	pagination: {
		transform: (response: Response) => {
			if (response.request.options.responseType === 'json') {
				return response.body;
			}

			return JSON.parse(response.body as string);
		},
		paginate: ({response}) => {
			const rawLinkHeader = response.headers.link;
			if (typeof rawLinkHeader !== 'string' || rawLinkHeader.trim() === '') {
				return false;
			}

			const parsed = parseLinkHeader(rawLinkHeader);
			const next = parsed.find(entry => entry.parameters.rel === 'next' || entry.parameters.rel === '"next"');

			if (next) {
				return {
					url: new URL(next.reference, response.url),
				};
			}

			return false;
		},
		filter: () => true,
		shouldContinue: () => true,
		countLimit: Number.POSITIVE_INFINITY,
		backoff: 0,
		requestLimit: 10_000,
		stackAllItems: false,
	},
	setHost: true,
	maxHeaderSize: undefined,
};

const cloneInternals = (internals: typeof defaultInternals) => {
	const {hooks, retry} = internals;

	const result: typeof defaultInternals = {
		...internals,
		context: {...internals.context},
		cacheOptions: {...internals.cacheOptions},
		https: {...internals.https},
		agent: {...internals.agent},
		headers: {...internals.headers},
		retry: {
			...retry,
			errorCodes: [...retry.errorCodes!],
			methods: [...retry.methods!],
			statusCodes: [...retry.statusCodes!],
		},
		timeout: {...internals.timeout},
		hooks: {
			init: [...hooks.init],
			beforeRequest: [...hooks.beforeRequest],
			beforeError: [...hooks.beforeError],
			beforeRedirect: [...hooks.beforeRedirect],
			beforeRetry: [...hooks.beforeRetry],
			afterResponse: [...hooks.afterResponse],
		},
		searchParams: internals.searchParams ? new URLSearchParams(internals.searchParams as URLSearchParams) : undefined,
		pagination: {...internals.pagination},
	};

	if (result.url !== undefined) {
		result.prefixUrl = '';
	}

	return result;
};

const getHttp2TimeoutOption = (internals: typeof defaultInternals): number | undefined => {
	const delays = [internals.timeout.socket, internals.timeout.connect, internals.timeout.lookup, internals.timeout.request, internals.timeout.secureConnect].filter(delay => typeof delay === 'number') as number[];

	if (delays.length > 0) {
		return Math.min(...delays);
	}

	return undefined;
};

const init = (options: OptionsInit, withOptions: OptionsInit, self: Options): void => {
	const initHooks = options.hooks?.init;
	if (initHooks) {
		for (const hook of initHooks) {
			hook(withOptions, self);
		}
	}
};

export default class Options {
	private _unixOptions?: NativeRequestOptions;
	private _internals: InternalsType;
	private _merging: boolean;
	private readonly _init: OptionsInit[];

	constructor(input?: string | URL | OptionsInit, options?: OptionsInit, defaults?: Options) {
		assert.any([is.string, is.urlInstance, is.object, is.undefined], input);
		assert.any([is.object, is.undefined], options);
		assert.any([is.object, is.undefined], defaults);

		if (input instanceof Options || options instanceof Options) {
			throw new TypeError('The defaults must be passed as the third argument');
		}

		this._internals = cloneInternals(defaults?._internals ?? defaults ?? defaultInternals);
		this._init = [...(defaults?._init ?? [])];
		this._merging = false;
		this._unixOptions = undefined;

		// This rule allows `finally` to be considered more important.
		// Meaning no matter the error thrown in the `try` block,
		// if `finally` throws then the `finally` error will be thrown.
		//
		// Yes, we want this. If we set `url` first, then the `url.searchParams`
		// would get merged. Instead we set the `searchParams` first, then
		// `url.searchParams` is overwritten as expected.
		//
		/* eslint-disable no-unsafe-finally */
		try {
			if (is.plainObject(input)) {
				try {
					this.merge(input);
					this.merge(options);
				} finally {
					this.url = input.url;
				}
			} else {
				try {
					this.merge(options);
				} finally {
					if (options?.url !== undefined) {
						if (input === undefined) {
							this.url = options.url;
						} else {
							throw new TypeError('The `url` option is mutually exclusive with the `input` argument');
						}
					} else if (input !== undefined) {
						this.url = input;
					}
				}
			}
		} catch (error) {
			(error as OptionsError).options = this;

			throw error;
		}
		/* eslint-enable no-unsafe-finally */
	}

	merge(options?: OptionsInit | Options) {
		if (!options) {
			return;
		}

		if (options instanceof Options) {
			for (const init of options._init) {
				this.merge(init);
			}

			return;
		}

		init(this, options, this);
		init(options, options, this);

		// This is way much faster than cloning ^_^
		Object.freeze(options);
		Object.freeze(options.hooks);
		Object.freeze(options.https);
		Object.freeze(options.cacheOptions);
		Object.freeze(options.agent);
		Object.freeze(options.headers);
		Object.freeze(options.timeout);
		Object.freeze(options.retry);
		Object.freeze(options.hooks);
		Object.freeze(options.context);

		this._merging = true;

		// Always merge `isStream` first
		if ('isStream' in options) {
			this.isStream = options.isStream!;
		}

		try {
			let push = false;

			for (const key in options) {
				// `got.extend()` options
				if (key === 'mutableDefaults' || key === 'handlers') {
					continue;
				}

				// Never merge `url`
				if (key === 'url') {
					continue;
				}

				if (!(key in this)) {
					throw new Error(`Unexpected option: ${key}`);
				}

				// @ts-expect-error Type 'unknown' is not assignable to type 'never'.
				this[key as keyof Options] = options[key as keyof Options];

				push = true;
			}

			if (push) {
				this._init.push(options);
			}
		} finally {
			this._merging = false;
		}
	}

	/**
	Custom request function.
	The main purpose of this is to [support HTTP2 using a wrapper](https://github.com/szmarczak/http2-wrapper).

	@default http.request | https.request
	*/
	get request(): RequestFunction | undefined {
		return this._internals.request;
	}

	set request(value: RequestFunction | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._internals.request = value;
	}

	/**
	An object representing `http`, `https` and `http2` keys for [`http.Agent`](https://nodejs.org/api/http.html#http_class_http_agent), [`https.Agent`](https://nodejs.org/api/https.html#https_class_https_agent) and [`http2wrapper.Agent`](https://github.com/szmarczak/http2-wrapper#new-http2agentoptions) instance.
	This is necessary because a request to one protocol might redirect to another.
	In such a scenario, Got will switch over to the right protocol agent for you.

	If a key is not present, it will default to a global agent.

	@example
	```
	import got from 'got';
	import HttpAgent from 'agentkeepalive';

	const {HttpsAgent} = HttpAgent;

	await got('https://sindresorhus.com', {
		agent: {
			http: new HttpAgent(),
			https: new HttpsAgent()
		}
	});
	```
	*/
	get agent(): Agents {
		return this._internals.agent;
	}

	set agent(value: Agents) {
		assert.plainObject(value);

		// eslint-disable-next-line guard-for-in
		for (const key in value) {
			if (!(key in this._internals.agent)) {
				throw new TypeError(`Unexpected agent option: ${key}`);
			}

			assert.any([is.object, is.undefined], value[key]);
		}

		if (this._merging) {
			Object.assign(this._internals.agent, value);
		} else {
			this._internals.agent = {...value};
		}
	}

	get h2session(): ClientHttp2Session | undefined {
		return this._internals.h2session;
	}

	set h2session(value: ClientHttp2Session | undefined) {
		this._internals.h2session = value;
	}

	/**
	Decompress the response automatically.

	This will set the `accept-encoding` header to `gzip, deflate, br` unless you set it yourself.

	If this is disabled, a compressed response is returned as a `Buffer`.
	This may be useful if you want to handle decompression yourself or stream the raw compressed data.

	@default true
	*/
	get decompress(): boolean {
		return this._internals.decompress;
	}

	set decompress(value: boolean) {
		assert.boolean(value);

		this._internals.decompress = value;
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
	get timeout(): Delays {
		// We always return `Delays` here.
		// It has to be `Delays | number`, otherwise TypeScript will error because the getter and the setter have incompatible types.
		return this._internals.timeout;
	}

	set timeout(value: Delays) {
		assert.plainObject(value);

		// eslint-disable-next-line guard-for-in
		for (const key in value) {
			if (!(key in this._internals.timeout)) {
				throw new Error(`Unexpected timeout option: ${key}`);
			}

			assert.any([is.number, is.undefined], value[key]);
		}

		if (this._merging) {
			Object.assign(this._internals.timeout, value);
		} else {
			this._internals.timeout = {...value};
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
	import got from 'got';

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
	```
	*/
	get prefixUrl(): string | URL {
		// We always return `string` here.
		// It has to be `string | URL`, otherwise TypeScript will error because the getter and the setter have incompatible types.
		return this._internals.prefixUrl;
	}

	set prefixUrl(value: string | URL) {
		assert.any([is.string, is.urlInstance], value);

		if (value === '') {
			this._internals.prefixUrl = '';
			return;
		}

		value = value.toString();

		if (!value.endsWith('/')) {
			value += '/';
		}

		if (this._internals.prefixUrl && this._internals.url) {
			const {href} = this._internals.url as URL;

			(this._internals.url as URL).href = value + href.slice((this._internals.prefixUrl as string).length);
		}

		this._internals.prefixUrl = value;
	}

	/**
	__Note #1__: The `body` option cannot be used with the `json` or `form` option.

	__Note #2__: If you provide this option, `got.stream()` will be read-only.

	__Note #3__: If you provide a payload with the `GET` or `HEAD` method, it will throw a `TypeError` unless the method is `GET` and the `allowGetBody` option is set to `true`.

	__Note #4__: This option is not enumerable and will not be merged with the instance defaults.

	The `content-length` header will be automatically set if `body` is a `string` / `Buffer` / [`form-data` instance](https://github.com/form-data/form-data), and `content-length` and `transfer-encoding` are not manually set in `options.headers`.

	Since Got 12, the `content-length` is not automatically set when `body` is a `fs.createReadStream`.
	*/
	get body(): string | Buffer | Readable | Generator | AsyncGenerator | undefined {
		return this._internals.body;
	}

	set body(value: string | Buffer | Readable | Generator | AsyncGenerator | undefined) {
		assert.any([is.string, is.buffer, is.nodeStream, is.generator, is.asyncGenerator, is.undefined], value);

		if (is.nodeStream(value)) {
			assert.truthy(value.readable);
		}

		if (value !== undefined) {
			assert.undefined(this._internals.form);
			assert.undefined(this._internals.json);
		}

		this._internals.body = value;
	}

	/**
	The form body is converted to a query string using [`(new URLSearchParams(object)).toString()`](https://nodejs.org/api/url.html#url_constructor_new_urlsearchparams_obj).

	If the `Content-Type` header is not present, it will be set to `application/x-www-form-urlencoded`.

	__Note #1__: If you provide this option, `got.stream()` will be read-only.

	__Note #2__: This option is not enumerable and will not be merged with the instance defaults.
	*/
	get form(): Record<string, any> | undefined {
		return this._internals.form;
	}

	set form(value: Record<string, any> | undefined) {
		assert.any([is.plainObject, is.undefined], value);

		if (value !== undefined) {
			assert.undefined(this._internals.body);
			assert.undefined(this._internals.json);
		}

		this._internals.form = value;
	}

	/**
	JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.

	__Note #1__: If you provide this option, `got.stream()` will be read-only.

	__Note #2__: This option is not enumerable and will not be merged with the instance defaults.
	*/
	get json(): Record<string, any> | undefined {
		return this._internals.json;
	}

	set json(value: Record<string, any> | undefined) {
		assert.any([is.object, is.undefined], value);

		if (value !== undefined) {
			assert.undefined(this._internals.body);
			assert.undefined(this._internals.form);
		}

		this._internals.json = value;
	}

	/**
	The URL to request, as a string, a [`https.request` options object](https://nodejs.org/api/https.html#https_https_request_options_callback), or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url).

	Properties from `options` will override properties in the parsed `url`.

	If no protocol is specified, it will throw a `TypeError`.

	__Note__: The query string is **not** parsed as search params.

	@example
	```
	await got('https://example.com/?query=a b'); //=> https://example.com/?query=a%20b
	await got('https://example.com/', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b

	// The query string is overridden by `searchParams`
	await got('https://example.com/?query=a b', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b
	```
	*/
	get url(): string | URL | undefined {
		return this._internals.url;
	}

	set url(value: string | URL | undefined) {
		assert.any([is.string, is.urlInstance, is.undefined], value);

		if (value === undefined) {
			this._internals.url = undefined;
			return;
		}

		if (is.string(value) && value.startsWith('/')) {
			throw new Error('`url` must not start with a slash');
		}

		const urlString = `${this.prefixUrl as string}${value.toString()}`;
		const url = new URL(urlString);
		this._internals.url = url;
		decodeURI(urlString);

		if (url.protocol === 'unix:') {
			url.href = `http://unix${url.pathname}${url.search}`;
		}

		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			const error: NodeJS.ErrnoException = new Error(`Unsupported protocol: ${url.protocol}`);
			error.code = 'ERR_UNSUPPORTED_PROTOCOL';

			throw error;
		}

		if (this._internals.username) {
			url.username = this._internals.username;
			this._internals.username = '';
		}

		if (this._internals.password) {
			url.password = this._internals.password;
			this._internals.password = '';
		}

		if (this._internals.searchParams) {
			url.search = (this._internals.searchParams as URLSearchParams).toString();
			this._internals.searchParams = undefined;
		}

		if (url.hostname === 'unix') {
			const matches = /(?<socketPath>.+?):(?<path>.+)/.exec(`${url.pathname}${url.search}`);

			if (matches?.groups) {
				const {socketPath, path} = matches.groups;

				this._unixOptions = {
					socketPath,
					path,
					host: '',
				};
			} else {
				this._unixOptions = undefined;
			}

			return;
		}

		this._unixOptions = undefined;
	}

	/**
	Cookie support. You don't have to care about parsing or how to store them.

	__Note__: If you provide this option, `options.headers.cookie` will be overridden.
	*/
	get cookieJar(): PromiseCookieJar | ToughCookieJar | undefined {
		return this._internals.cookieJar;
	}

	set cookieJar(value: PromiseCookieJar | ToughCookieJar | undefined) {
		assert.any([is.object, is.undefined], value);

		if (value === undefined) {
			this._internals.cookieJar = undefined;
			return;
		}

		let {setCookie, getCookieString} = value;

		assert.function_(setCookie);
		assert.function_(getCookieString);

		/* istanbul ignore next: Horrible `tough-cookie` v3 check */
		if (setCookie.length === 4 && getCookieString.length === 0) {
			setCookie = promisify(setCookie.bind(value));
			getCookieString = promisify(getCookieString.bind(value));

			this._internals.cookieJar = {
				setCookie,
				getCookieString: getCookieString as PromiseCookieJar['getCookieString'],
			};
		} else {
			this._internals.cookieJar = value;
		}
	}

	/**
	Ignore invalid cookies instead of throwing an error.
	Only useful when the `cookieJar` option has been set. Not recommended.

	@default false
	*/
	get ignoreInvalidCookies(): boolean {
		return this._internals.ignoreInvalidCookies;
	}

	set ignoreInvalidCookies(value: boolean) {
		assert.boolean(value);

		this._internals.ignoreInvalidCookies = value;
	}

	/**
	Query string that will be added to the request URL.
	This will override the query string in `url`.

	If you need to pass in an array, you can do it using a `URLSearchParams` instance.

	@example
	```
	import got from 'got';

	const searchParams = new URLSearchParams([['key', 'a'], ['key', 'b']]);

	await got('https://example.com', {searchParams});

	console.log(searchParams.toString());
	//=> 'key=a&key=b'
	```
	*/
	get searchParams(): string | SearchParameters | URLSearchParams | undefined {
		if (this._internals.url) {
			return (this._internals.url as URL).searchParams;
		}

		if (this._internals.searchParams === undefined) {
			this._internals.searchParams = new URLSearchParams();
		}

		return this._internals.searchParams;
	}

	set searchParams(value: string | SearchParameters | URLSearchParams | undefined) {
		assert.any([is.string, is.object, is.undefined], value);

		const url = this._internals.url as URL;

		if (value === undefined) {
			this._internals.searchParams = undefined;

			if (url) {
				url.search = '';
			}

			return;
		}

		const searchParameters = this.searchParams as URLSearchParams;
		let updated;

		if (is.string(value)) {
			updated = new URLSearchParams(value);
		} else if (value instanceof URLSearchParams) {
			updated = value;
		} else {
			validateSearchParameters(value);

			updated = new URLSearchParams();

			// eslint-disable-next-line guard-for-in
			for (const key in value) {
				const entry = value[key];

				if (entry === null) {
					updated.append(key, '');
				} else if (entry === undefined) {
					searchParameters.delete(key);
				} else {
					updated.append(key, entry as string);
				}
			}
		}

		if (this._merging) {
			// These keys will be replaced
			for (const key of updated.keys()) {
				searchParameters.delete(key);
			}

			for (const [key, value] of updated) {
				searchParameters.append(key, value);
			}
		} else if (url) {
			url.search = searchParameters.toString();
		} else {
			this._internals.searchParams = searchParameters;
		}
	}

	get searchParameters() {
		throw new Error('The `searchParameters` option does not exist. Use `searchParams` instead.');
	}

	set searchParameters(_value: unknown) {
		throw new Error('The `searchParameters` option does not exist. Use `searchParams` instead.');
	}

	get dnsLookup(): CacheableLookup['lookup'] | undefined {
		return this._internals.dnsLookup;
	}

	set dnsLookup(value: CacheableLookup['lookup'] | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._internals.dnsLookup = value;
	}

	/**
	An instance of [`CacheableLookup`](https://github.com/szmarczak/cacheable-lookup) used for making DNS lookups.
	Useful when making lots of requests to different *public* hostnames.

	`CacheableLookup` uses `dns.resolver4(..)` and `dns.resolver6(...)` under the hood and fall backs to `dns.lookup(...)` when the first two fail, which may lead to additional delay.

	__Note__: This should stay disabled when making requests to internal hostnames such as `localhost`, `database.local` etc.

	@default false
	*/
	get dnsCache(): CacheableLookup | boolean | undefined {
		return this._internals.dnsCache;
	}

	set dnsCache(value: CacheableLookup | boolean | undefined) {
		assert.any([is.object, is.boolean, is.undefined], value);

		if (value === true) {
			this._internals.dnsCache = getGlobalDnsCache();
		} else if (value === false) {
			this._internals.dnsCache = undefined;
		} else {
			this._internals.dnsCache = value;
		}
	}

	/**
	User data. `context` is shallow merged and enumerable. If it contains non-enumerable properties they will NOT be merged.

	@example
	```
	import got from 'got';

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

	const context = {
		token: 'secret'
	};

	const response = await instance('https://httpbin.org/headers', {context});

	// Let's see the headers
	console.log(response.body);
	```
	*/
	get context(): Record<string, unknown> {
		return this._internals.context;
	}

	set context(value: Record<string, unknown>) {
		assert.object(value);

		if (this._merging) {
			Object.assign(this._internals.context, value);
		} else {
			this._internals.context = {...value};
		}
	}

	/**
	Hooks allow modifications during the request lifecycle.
	Hook functions may be async and are run serially.
	*/
	get hooks(): Hooks {
		return this._internals.hooks;
	}

	set hooks(value: Hooks) {
		assert.object(value);

		// eslint-disable-next-line guard-for-in
		for (const knownHookEvent in value) {
			if (!(knownHookEvent in this._internals.hooks)) {
				throw new Error(`Unexpected hook event: ${knownHookEvent}`);
			}

			const typedKnownHookEvent = knownHookEvent as keyof Hooks;
			const typedValue = value as Hooks;
			const hooks = typedValue[typedKnownHookEvent];

			assert.any([is.array, is.undefined], hooks);

			if (hooks) {
				for (const hook of hooks) {
					assert.function_(hook);
				}
			}

			if (this._merging) {
				if (hooks) {
					// @ts-expect-error FIXME
					this._internals.hooks[typedKnownHookEvent].push(...hooks);
				}
			} else {
				if (!hooks) {
					throw new Error(`Missing hook event: ${knownHookEvent}`);
				}

				// @ts-expect-error FIXME
				this._internals.hooks[knownHookEvent] = [...hooks];
			}
		}
	}

	/**
	Defines if redirect responses should be followed automatically.

	Note that if a `303` is sent by the server in response to any request type (`POST`, `DELETE`, etc.), Got will automatically request the resource pointed to in the location header via `GET`.
	This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4).

	@default true
	*/
	get followRedirect(): boolean {
		return this._internals.followRedirect;
	}

	set followRedirect(value: boolean) {
		assert.boolean(value);

		this._internals.followRedirect = value;
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
		return this._internals.maxRedirects;
	}

	set maxRedirects(value: number) {
		assert.number(value);

		this._internals.maxRedirects = value;
	}

	/**
	A cache adapter instance for storing cached response data.

	@default false
	*/
	get cache(): string | CacheableRequest.StorageAdapter | boolean | undefined {
		return this._internals.cache;
	}

	set cache(value: string | CacheableRequest.StorageAdapter | boolean | undefined) {
		assert.any([is.object, is.string, is.boolean, is.undefined], value);

		if (value === true) {
			this._internals.cache = globalCache;
		} else if (value === false) {
			this._internals.cache = undefined;
		} else {
			this._internals.cache = value;
		}
	}

	/**
	Determines if a `got.HTTPError` is thrown for unsuccessful responses.

	If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing.
	This may be useful if you are checking for resource availability and are expecting error responses.

	@default true
	*/
	get throwHttpErrors(): boolean {
		return this._internals.throwHttpErrors;
	}

	set throwHttpErrors(value: boolean) {
		assert.boolean(value);

		this._internals.throwHttpErrors = value;
	}

	get username(): string {
		const url = this._internals.url as URL;

		const value = url ? url.username : this._internals.username;

		return decodeURIComponent(value);
	}

	set username(value: string) {
		assert.string(value);

		const url = this._internals.url as URL;
		const fixedValue = encodeURIComponent(value);

		if (url) {
			url.username = fixedValue;
		} else {
			this._internals.username = fixedValue;
		}
	}

	get password(): string {
		const url = this._internals.url as URL;

		const value = url ? url.password : this._internals.password;

		return decodeURIComponent(value);
	}

	set password(value: string) {
		assert.string(value);

		const url = this._internals.url as URL;

		const fixedValue = encodeURIComponent(value);

		if (url) {
			url.password = fixedValue;
		} else {
			this._internals.password = fixedValue;
		}
	}

	/**
	If set to `true`, Got will additionally accept HTTP2 requests.

	It will choose either HTTP/1.1 or HTTP/2 depending on the ALPN protocol.

	__Note__: This option requires Node.js 15.10.0 or newer as HTTP/2 support on older Node.js versions is very buggy.

	__Note__: Overriding `options.request` will disable HTTP2 support.

	@default false

	@example
	```
	import got from 'got';

	const {headers} = await got('https://nghttp2.org/httpbin/anything', {http2: true});

	console.log(headers.via);
	//=> '2 nghttpx'
	```
	*/
	get http2(): boolean {
		return this._internals.http2;
	}

	set http2(value: boolean) {
		assert.boolean(value);

		this._internals.http2 = value;
	}

	/**
	Set this to `true` to allow sending body for the `GET` method.
	However, the [HTTP/2 specification](https://tools.ietf.org/html/rfc7540#section-8.1.3) says that `An HTTP GET request includes request header fields and no payload body`, therefore when using the HTTP/2 protocol this option will have no effect.
	This option is only meant to interact with non-compliant servers when you have no other choice.

	__Note__: The [RFC 7321](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore __it's considered an [anti-pattern](https://en.wikipedia.org/wiki/Anti-pattern)__.

	@default false
	*/
	get allowGetBody(): boolean {
		return this._internals.allowGetBody;
	}

	set allowGetBody(value: boolean) {
		assert.boolean(value);

		this._internals.allowGetBody = value;
	}

	/**
	Request headers.

	Existing headers will be overwritten. Headers set to `undefined` will be omitted.

	@default {}
	*/
	get headers(): Headers {
		return this._internals.headers;
	}

	set headers(value: Headers) {
		assert.plainObject(value);

		if (this._merging) {
			Object.assign(this._internals.headers, lowercaseKeys(value));
		} else {
			this._internals.headers = lowercaseKeys(value);
		}
	}

	/**
	Specifies if the redirects should be [rewritten as `GET`](https://tools.ietf.org/html/rfc7231#section-6.4).

	If `false`, when sending a POST request and receiving a `302`, it will resend the body to the new location using the same HTTP method (`POST` in this case).

	@default false
	*/
	get methodRewriting(): boolean {
		return this._internals.methodRewriting;
	}

	set methodRewriting(value: boolean) {
		assert.boolean(value);

		this._internals.methodRewriting = value;
	}

	/**
	Indicates which DNS record family to use.

	Values:
	- `undefined`: IPv4 (if present) or IPv6
	- `4`: Only IPv4
	- `6`: Only IPv6

	@default undefined
	*/
	get dnsLookupIpVersion(): DnsLookupIpVersion {
		return this._internals.dnsLookupIpVersion;
	}

	set dnsLookupIpVersion(value: DnsLookupIpVersion) {
		if (value !== undefined && value !== 4 && value !== 6) {
			throw new TypeError(`Invalid DNS lookup IP version: ${value as string}`);
		}

		this._internals.dnsLookupIpVersion = value;
	}

	/**
	A function used to parse JSON responses.

	@example
	```
	import got from 'got';
	import Bourne from '@hapi/bourne';

	const parsed = await got('https://example.com', {
		parseJson: text => Bourne.parse(text)
	}).json();

	console.log(parsed);
	```
	*/
	get parseJson(): ParseJsonFunction {
		return this._internals.parseJson;
	}

	set parseJson(value: ParseJsonFunction) {
		assert.function_(value);

		this._internals.parseJson = value;
	}

	/**
	A function used to stringify the body of JSON requests.

	@example
	```
	import got from 'got';

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
	```

	@example
	```
	import got from 'got';

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
	```
	*/
	get stringifyJson(): StringifyJsonFunction {
		return this._internals.stringifyJson;
	}

	set stringifyJson(value: StringifyJsonFunction) {
		assert.function_(value);

		this._internals.stringifyJson = value;
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
	get retry(): Partial<RetryOptions> {
		return this._internals.retry;
	}

	set retry(value: Partial<RetryOptions>) {
		assert.plainObject(value);

		assert.any([is.function_, is.undefined], value.calculateDelay);
		assert.any([is.number, is.undefined], value.maxRetryAfter);
		assert.any([is.number, is.undefined], value.limit);
		assert.any([is.array, is.undefined], value.methods);
		assert.any([is.array, is.undefined], value.statusCodes);
		assert.any([is.array, is.undefined], value.errorCodes);
		assert.any([is.number, is.undefined], value.noise);

		if (value.noise && Math.abs(value.noise) > 100) {
			throw new Error(`The maximum acceptable retry noise is +/- 100ms, got ${value.noise}`);
		}

		for (const key in value) {
			if (!(key in this._internals.retry)) {
				throw new Error(`Unexpected retry option: ${key}`);
			}
		}

		if (this._merging) {
			Object.assign(this._internals.retry, value);
		} else {
			this._internals.retry = {...value};
		}

		const {retry} = this._internals;

		retry.methods = [...new Set(retry.methods!.map(method => method.toUpperCase() as Method))];
		retry.statusCodes = [...new Set(retry.statusCodes)];
		retry.errorCodes = [...new Set(retry.errorCodes)];
	}

	/**
	From `http.RequestOptions`.

	The IP address used to send the request from.
	*/
	get localAddress(): string | undefined {
		return this._internals.localAddress;
	}

	set localAddress(value: string | undefined) {
		assert.any([is.string, is.undefined], value);

		this._internals.localAddress = value;
	}

	/**
	The HTTP method used to make the request.

	@default 'GET'
	*/
	get method(): Method {
		return this._internals.method;
	}

	set method(value: Method) {
		assert.string(value);

		this._internals.method = value.toUpperCase() as Method;
	}

	get createConnection(): CreateConnectionFunction | undefined {
		return this._internals.createConnection;
	}

	set createConnection(value: CreateConnectionFunction | undefined) {
		assert.any([is.function_, is.undefined], value);

		this._internals.createConnection = value;
	}

	/**
	From `http-cache-semantics`

	@default {}
	*/
	get cacheOptions(): CacheOptions {
		return this._internals.cacheOptions;
	}

	set cacheOptions(value: CacheOptions) {
		assert.plainObject(value);

		assert.any([is.boolean, is.undefined], value.shared);
		assert.any([is.number, is.undefined], value.cacheHeuristic);
		assert.any([is.number, is.undefined], value.immutableMinTimeToLive);
		assert.any([is.boolean, is.undefined], value.ignoreCargoCult);

		for (const key in value) {
			if (!(key in this._internals.cacheOptions)) {
				throw new Error(`Cache option \`${key}\` does not exist`);
			}
		}

		if (this._merging) {
			Object.assign(this._internals.cacheOptions, value);
		} else {
			this._internals.cacheOptions = {...value};
		}
	}

	/**
	Options for the advanced HTTPS API.
	*/
	get https(): HttpsOptions {
		return this._internals.https;
	}

	set https(value: HttpsOptions) {
		assert.plainObject(value);

		assert.any([is.boolean, is.undefined], value.rejectUnauthorized);
		assert.any([is.function_, is.undefined], value.checkServerIdentity);
		assert.any([is.string, is.object, is.array, is.undefined], value.certificateAuthority);
		assert.any([is.string, is.object, is.array, is.undefined], value.key);
		assert.any([is.string, is.object, is.array, is.undefined], value.certificate);
		assert.any([is.string, is.undefined], value.passphrase);
		assert.any([is.string, is.buffer, is.array, is.undefined], value.pfx);
		assert.any([is.array, is.undefined], value.alpnProtocols);
		assert.any([is.string, is.undefined], value.ciphers);
		assert.any([is.string, is.buffer, is.undefined], value.dhparam);
		assert.any([is.string, is.undefined], value.signatureAlgorithms);
		assert.any([is.string, is.undefined], value.minVersion);
		assert.any([is.string, is.undefined], value.maxVersion);
		assert.any([is.boolean, is.undefined], value.honorCipherOrder);
		assert.any([is.number, is.undefined], value.tlsSessionLifetime);
		assert.any([is.string, is.undefined], value.ecdhCurve);
		assert.any([is.string, is.buffer, is.array, is.undefined], value.certificateRevocationLists);

		for (const key in value) {
			if (!(key in this._internals.https)) {
				throw new Error(`HTTPS option \`${key}\` does not exist`);
			}
		}

		if (this._merging) {
			Object.assign(this._internals.https, value);
		} else {
			this._internals.https = {...value};
		}
	}

	/**
	[Encoding](https://nodejs.org/api/buffer.html#buffer_buffers_and_character_encodings) to be used on `setEncoding` of the response data.

	To get a [`Buffer`](https://nodejs.org/api/buffer.html), you need to set `responseType` to `buffer` instead.
	Don't set this option to `null`.

	__Note__: This doesn't affect streams! Instead, you need to do `got.stream(...).setEncoding(encoding)`.

	@default 'utf-8'
	*/
	get encoding(): BufferEncoding | undefined {
		return this._internals.encoding;
	}

	set encoding(value: BufferEncoding | undefined) {
		if (value === null) {
			throw new TypeError('To get a Buffer, set `options.responseType` to `buffer` instead');
		}

		assert.any([is.string, is.undefined], value);

		this._internals.encoding = value;
	}

	/**
	When set to `true` the promise will return the Response body instead of the Response object.

	@default false
	*/
	get resolveBodyOnly(): boolean {
		return this._internals.resolveBodyOnly;
	}

	set resolveBodyOnly(value: boolean) {
		assert.boolean(value);

		this._internals.resolveBodyOnly = value;
	}

	/**
	Returns a `Stream` instead of a `Promise`.
	This is equivalent to calling `got.stream(url, options?)`.

	@default false
	*/
	get isStream(): boolean {
		return this._internals.isStream;
	}

	set isStream(value: boolean) {
		assert.boolean(value);

		this._internals.isStream = value;
	}

	/**
	The parsing method.

	The promise also has `.text()`, `.json()` and `.buffer()` methods which return another Got promise for the parsed body.

	It's like setting the options to `{responseType: 'json', resolveBodyOnly: true}` but without affecting the main Got promise.

	__Note__: When using streams, this option is ignored.

	@example
	```
	const responsePromise = got(url);
	const bufferPromise = responsePromise.buffer();
	const jsonPromise = responsePromise.json();

	const [response, buffer, json] = Promise.all([responsePromise, bufferPromise, jsonPromise]);
	// `response` is an instance of Got Response
	// `buffer` is an instance of Buffer
	// `json` is an object
	```

	@example
	```
	// This
	const body = await got(url).json();

	// is semantically the same as this
	const body = await got(url, {responseType: 'json', resolveBodyOnly: true});
	```
	*/
	get responseType(): ResponseType {
		return this._internals.responseType;
	}

	set responseType(value: ResponseType) {
		if (value === undefined) {
			this._internals.responseType = 'text';
			return;
		}

		if (value !== 'text' && value !== 'buffer' && value !== 'json') {
			throw new Error(`Invalid \`responseType\` option: ${value as string}`);
		}

		this._internals.responseType = value;
	}

	get pagination(): PaginationOptions<unknown, unknown> {
		return this._internals.pagination;
	}

	set pagination(value: PaginationOptions<unknown, unknown>) {
		assert.object(value);

		if (this._merging) {
			Object.assign(this._internals.pagination, value);
		} else {
			this._internals.pagination = value;
		}
	}

	get auth() {
		throw new Error('Parameter `auth` is deprecated. Use `username` / `password` instead.');
	}

	set auth(_value: unknown) {
		throw new Error('Parameter `auth` is deprecated. Use `username` / `password` instead.');
	}

	get setHost() {
		return this._internals.setHost;
	}

	set setHost(value: boolean) {
		assert.boolean(value);

		this._internals.setHost = value;
	}

	get maxHeaderSize() {
		return this._internals.maxHeaderSize;
	}

	set maxHeaderSize(value: number | undefined) {
		assert.any([is.number, is.undefined], value);

		this._internals.maxHeaderSize = value;
	}

	toJSON() {
		return {...this._internals};
	}

	[Symbol.for('nodejs.util.inspect.custom')](_depth: number, options: InspectOptions) {
		return inspect(this._internals, options);
	}

	createNativeRequestOptions() {
		const internals = this._internals;
		const url = internals.url as URL;

		let agent;
		if (url.protocol === 'https:') {
			agent = internals.http2 ? internals.agent : internals.agent.https;
		} else {
			agent = internals.agent.http;
		}

		const {https} = internals;
		let {pfx} = https;

		if (is.array(pfx) && is.plainObject(pfx[0])) {
			pfx = (pfx as PfxObject[]).map(object => ({
				buf: object.buffer,
				passphrase: object.passphrase,
			})) as any;
		}

		return {
			...internals.cacheOptions,
			...this._unixOptions,

			// HTTPS options
			ca: https.certificateAuthority,
			cert: https.certificate,
			key: https.key,
			passphrase: https.passphrase,
			pfx: https.pfx,
			rejectUnauthorized: https.rejectUnauthorized,
			checkServerIdentity: https.checkServerIdentity ?? checkServerIdentity,
			ciphers: https.ciphers,
			honorCipherOrder: https.honorCipherOrder,
			minVersion: https.minVersion,
			maxVersion: https.maxVersion,
			sigalgs: https.signatureAlgorithms,
			sessionTimeout: https.tlsSessionLifetime,
			dhparam: https.dhparam,
			ecdhCurve: https.ecdhCurve,
			crl: https.certificateRevocationLists,

			// HTTP options
			lookup: internals.dnsLookup ?? (internals.dnsCache as CacheableLookup | undefined)?.lookup,
			family: internals.dnsLookupIpVersion,
			agent,
			setHost: internals.setHost,
			method: internals.method,
			maxHeaderSize: internals.maxHeaderSize,
			localAddress: internals.localAddress,
			headers: internals.headers,
			createConnection: internals.createConnection,
			timeout: internals.http2 ? getHttp2TimeoutOption(internals) : undefined,

			// HTTP/2 options
			h2session: internals.h2session,
		};
	}

	getRequestFunction() {
		const url = this._internals.url as (URL | undefined);
		const {request} = this._internals;

		if (!request && url) {
			return this.getFallbackRequestFunction();
		}

		return request;
	}

	getFallbackRequestFunction() {
		const url = this._internals.url as (URL | undefined);

		if (!url) {
			return;
		}

		if (url.protocol === 'https:') {
			if (this._internals.http2) {
				if (major < 15 || (major === 15 && minor < 10)) {
					const error = new Error('To use the `http2` option, install Node.js 15.10.0 or above');
					(error as NodeJS.ErrnoException).code = 'EUNSUPPORTED';

					throw error;
				}

				return http2wrapper.auto as RequestFunction;
			}

			return httpsRequest;
		}

		return httpRequest;
	}

	freeze() {
		const options = this._internals;

		Object.freeze(options);
		Object.freeze(options.hooks);
		Object.freeze(options.https);
		Object.freeze(options.cacheOptions);
		Object.freeze(options.agent);
		Object.freeze(options.headers);
		Object.freeze(options.timeout);
		Object.freeze(options.retry);
		Object.freeze(options.hooks);
		Object.freeze(options.context);
	}
}
