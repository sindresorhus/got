import http = require('http');
import https = require('https');
import Keyv = require('keyv');
import CacheableRequest = require('cacheable-request');
import PCancelable = require('p-cancelable');
import ResponseLike = require('responselike');
import {URL} from 'url';
import {Readable as ReadableStream} from 'stream';
import {Timings, IncomingMessageWithTimings} from '@szmarczak/http-timer';
import CacheableLookup from 'cacheable-lookup';
import {Except, Merge} from 'type-fest';
import {GotReturn} from './create';
import {GotError, HTTPError, MaxRedirectsError, ParseError, TimeoutError, RequestError} from './errors';
import {Hooks} from './known-hook-events';
import {URLOptions} from './utils/options-to-url';

export type GeneralError = Error | GotError | HTTPError | MaxRedirectsError | ParseError;

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

export type ResponseType = 'json' | 'buffer' | 'text';

export interface Response<BodyType = unknown> extends IncomingMessageWithTimings {
	body: BodyType;
	statusCode: number;

	/**
	The remote IP address.

	Note: Not available when the response is cached. This is hopefully a temporary limitation, see [lukechilds/cacheable-request#86](https://github.com/lukechilds/cacheable-request/issues/86).
	*/
	ip: string;

	fromCache?: boolean;
	isFromCache?: boolean;
	req?: http.ClientRequest;
	requestUrl: string;
	retryCount: number;
	timings: Timings;
	redirectUrls: string[];
	request: {
		options: NormalizedOptions;
	};
	url: string;
}

// TODO: The `ResponseLike` type should be properly fixed instead:
// https://github.com/sindresorhus/got/pull/827/files#r323633794
export interface ResponseObject extends Partial<ResponseLike> {
	socket: {
		remoteAddress: string;
	};
}

export interface RetryObject {
	attemptCount: number;
	retryOptions: Required<RetryOptions>;
	error: TimeoutError | RequestError;
	computedValue: number;
}

export type RetryFunction = (retryObject: RetryObject) => number;

export type HandlerFunction = <T extends GotReturn>(options: NormalizedOptions, next: (options: NormalizedOptions) => T) => T | Promise<T>;

export interface DefaultRetryOptions {
	limit: number;
	methods: Method[];
	statusCodes: number[];
	errorCodes: string[];
	calculateDelay: RetryFunction;
	maxRetryAfter?: number;
}

export interface RetryOptions extends Partial<DefaultRetryOptions> {
	retries?: number;
}

export type RequestFunction = typeof http.request;

export interface AgentByProtocol {
	http?: http.Agent;
	https?: https.Agent;
}

export interface Delays {
	lookup?: number;
	connect?: number;
	secureConnect?: number;
	socket?: number;
	response?: number;
	send?: number;
	request?: number;
}

export type Headers = Record<string, string | string[] | undefined>;

interface ToughCookieJar {
	getCookieString(currentUrl: string, options: {[key: string]: unknown}, cb: (err: Error | null, cookies: string) => void): void;
	getCookieString(url: string, callback: (error: Error | null, cookieHeader: string) => void): void;
	setCookie(cookieOrString: unknown, currentUrl: string, options: {[key: string]: unknown}, cb: (err: Error | null, cookie: unknown) => void): void;
	setCookie(rawCookie: string, url: string, callback: (error: Error | null, result: unknown) => void): void;
}

interface PromiseCookieJar {
	getCookieString(url: string): Promise<string>;
	setCookie(rawCookie: string, url: string): Promise<unknown>;
}

export const requestSymbol = Symbol('request');

/* eslint-disable @typescript-eslint/indent */
export type DefaultOptions = Merge<
	Required<
		Except<
			GotOptions,
			// Override
			'hooks' |
			'retry' |
			'timeout' |
			'context' |
			'_pagination' |

			// Should not be present
			'agent' |
			'body' |
			'cookieJar' |
			'encoding' |
			'form' |
			'json' |
			'lookup' |
			'request' |
			'url' |
			typeof requestSymbol
		>
	>,
	{
		hooks: Required<Hooks>;
		retry: DefaultRetryOptions;
		timeout: Delays;
		context: {[key: string]: any};
		_pagination?: PaginationOptions<unknown>['_pagination'];
	}
>;
/* eslint-enable @typescript-eslint/indent */

export interface PaginationOptions<T> {
	_pagination?: {
		transform?: (response: Response) => Promise<T[]> | T[];
		filter?: (item: T, allItems: T[]) => boolean;
		paginate?: (response: Response) => Options | false;
		shouldContinue?: (item: T, allItems: T[]) => boolean;
		countLimit?: number;
	};
}

export interface GotOptions extends PaginationOptions<unknown> {
	[requestSymbol]?: RequestFunction;
	url?: URL | string;
	body?: string | Buffer | ReadableStream;
	hooks?: Hooks;
	decompress?: boolean;
	isStream?: boolean;
	encoding?: BufferEncoding;
	method?: Method;
	retry?: RetryOptions | number;
	throwHttpErrors?: boolean;
	cookieJar?: ToughCookieJar | PromiseCookieJar;
	ignoreInvalidCookies?: boolean;
	request?: RequestFunction;
	agent?: http.Agent | https.Agent | boolean | AgentByProtocol;
	cache?: string | CacheableRequest.StorageAdapter | false;
	headers?: Headers;
	responseType?: ResponseType;
	resolveBodyOnly?: boolean;
	followRedirect?: boolean;
	prefixUrl?: URL | string;
	timeout?: number | Delays;
	dnsCache?: CacheableLookup | Map<string, string> | Keyv | false;
	useElectronNet?: boolean;
	form?: {[key: string]: any};
	json?: {[key: string]: any};
	context?: {[key: string]: any};
	maxRedirects?: number;
	lookup?: CacheableLookup['lookup'];
	allowGetBody?: boolean;
	methodRewriting?: boolean;
}

export type Options = Merge<https.RequestOptions, Merge<GotOptions, URLOptions>>;

export interface NormalizedOptions extends Options {
	// Normalized Got options
	headers: Headers;
	hooks: Required<Hooks>;
	timeout: Delays;
	dnsCache: CacheableLookup | false;
	lookup?: CacheableLookup['lookup'];
	retry: Required<RetryOptions>;
	prefixUrl: string;
	method: Method;
	url: URL;
	cacheableRequest?: (options: string | URL | http.RequestOptions, callback?: (response: http.ServerResponse | ResponseLike) => void) => CacheableRequest.Emitter;
	cookieJar?: PromiseCookieJar;
	maxRedirects: number;
	pagination?: Required<PaginationOptions<unknown>['_pagination']>;
	[requestSymbol]: RequestFunction;

	// Other values
	decompress: boolean;
	isStream: boolean;
	throwHttpErrors: boolean;
	ignoreInvalidCookies: boolean;
	cache: CacheableRequest.StorageAdapter | false;
	responseType: ResponseType;
	resolveBodyOnly: boolean;
	followRedirect: boolean;
	useElectronNet: boolean;
	methodRewriting: boolean;
	allowGetBody: boolean;
	context: {[key: string]: any};

	// UNIX socket support
	path?: string;

	// Caseless headers
	setHeader(name: string, value: string | string[], clobber?: boolean): string | false;
	setHeader(headers: Headers): void;
	hasHeader(name: string): string | false;
	getHeader(name: string): string | string[] | undefined;
	removeHeader(name: string): boolean;
}

export interface ExtendOptions extends Options {
	handlers?: HandlerFunction[];
	mutableDefaults?: boolean;
}

export interface Defaults {
	options: DefaultOptions;
	handlers: HandlerFunction[];
	mutableDefaults: boolean;
	_rawHandlers?: HandlerFunction[];
}

export type URLOrOptions = Options | string;

export interface Progress {
	percent: number;
	transferred: number;
	total?: number;
}

export interface GotEvents<T> {
	on(name: 'request', listener: (request: http.ClientRequest) => void): T;
	on(name: 'response', listener: (response: Response) => void): T;
	on(name: 'redirect', listener: (response: Response, nextOptions: NormalizedOptions) => void): T;
	on(name: 'uploadProgress' | 'downloadProgress', listener: (progress: Progress) => void): T;
}

export interface CancelableRequest<T extends Response | Response['body']> extends PCancelable<T>, GotEvents<CancelableRequest<T>> {
	json<ReturnType>(): CancelableRequest<ReturnType>;
	buffer(): CancelableRequest<Buffer>;
	text(): CancelableRequest<string>;
}
