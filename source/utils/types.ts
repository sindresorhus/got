import http = require('http');
import https = require('https');
import Keyv = require('keyv');
import CacheableRequest = require('cacheable-request');
import PCancelable = require('p-cancelable');
import ResponseLike = require('responselike');
import {Readable as ReadableStream} from 'stream';
import CacheableLookup from 'cacheable-lookup';
import {Timings} from '@szmarczak/http-timer';
import {Except, Merge, PartialDeep} from 'type-fest';
import {GotReturn} from '../create';
import {GotError, HTTPError, MaxRedirectsError, ParseError} from '../errors';
import {Hooks} from '../known-hook-events';
import {URLOptions} from './options-to-url';

export type GenericError = Error | GotError | HTTPError | MaxRedirectsError | ParseError;

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

export type ErrorCode =
	| 'ETIMEDOUT'
	| 'ECONNRESET'
	| 'EADDRINUSE'
	| 'ECONNREFUSED'
	| 'EPIPE'
	| 'ENOTFOUND'
	| 'ENETUNREACH'
	| 'EAI_AGAIN';

export type ResponseType = 'json' | 'buffer' | 'text' | 'default';

export interface Response<BodyType = unknown> extends http.IncomingMessage {
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
	error: GotError | HTTPError | MaxRedirectsError | ParseError;
	computedValue: number;
}

export type RetryFunction = (retryObject: RetryObject) => number;

export type HandlerFunction = <T extends GotReturn>(options: NormalizedOptions, next: (options: NormalizedOptions) => T) => T;

export interface DefaultRetryOptions {
	limit: number;
	methods: Method[];
	statusCodes: number[];
	errorCodes: string[];
}

export interface RetryOptions extends Partial<DefaultRetryOptions> {
	calculateDelay?: RetryFunction;
	retries?: number;
	maxRetryAfter?: number;
}

export type RequestFunction = typeof https.request;

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

interface CookieJar {
	getCookieString(url: string, callback: (error: Error, cookieHeader: string) => void): void;
	getCookieString(url: string): Promise<string>;
	setCookie(rawCookie: string, url: string, callback: (error: Error, result: unknown) => void): void;
	setCookie(rawCookie: string, url: string): Promise<unknown>;
}

export interface DefaultOptions {
	method: Method;
	retry: DefaultRetryOptions | number;
	timeout: Delays | number;
	headers: Headers;
	hooks: Hooks;
	decompress: boolean;
	throwHttpErrors: boolean;
	followRedirect: boolean;
	isStream: boolean;
	cache: CacheableRequest.StorageAdapter | string | false;
	dnsCache: CacheableLookup | Map<string, string> | Keyv | false;
	useElectronNet: boolean;
	responseType: ResponseType;
	resolveBodyOnly: boolean;
	maxRedirects: number;
	prefixUrl: URL | string;
}

// TODO: Missing lots of `http` options
export interface Options extends PartialDeep<DefaultOptions>, URLOptions {
	url?: URL | string;
	body?: string | Buffer | ReadableStream;
	hostname?: string;
	socketPath?: string;
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	isStream?: boolean;
	encoding?: BufferEncoding | null;
	method?: Method;
	retry?: RetryOptions | number;
	throwHttpErrors?: boolean;
	cookieJar?: CookieJar;
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
	form?: Record<string, any>;
	json?: Record<string, any>;
	context?: {[key: string]: unknown};
	maxRedirects?: number;
	lookup?: CacheableLookup['lookup'];
}

export interface NormalizedOptions extends Except<DefaultOptions, 'dnsCache'>, Except<Options, keyof DefaultOptions | keyof URLOptions> {
	// Normalized Got options
	hooks: Required<Hooks>;
	timeout: Delays;
	dnsCache?: CacheableLookup | false;
	retry: Required<RetryOptions>;
	prefixUrl: string;
	method: Method;
	url: URL;
	cacheableRequest?: (options: string | URL | http.RequestOptions, callback?: (response: http.ServerResponse | ResponseLike) => void) => CacheableRequest.Emitter;

	// UNIX socket support
	path?: string;
}

export interface ExtendOptions extends Options {
	handlers?: HandlerFunction[];
	mutableDefaults?: boolean;
}

export type ExtendedOptions = DefaultOptions & Options;

export interface Defaults {
	options: Options;
	handlers: HandlerFunction[];
	mutableDefaults: boolean;
}

export interface NormalizedDefaults {
	options: Options;
	handlers: HandlerFunction[];
	_rawHandlers?: HandlerFunction[];
	mutableDefaults: boolean;
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

export interface CancelableRequest<T extends Response | Response['body']> extends Merge<PCancelable<T>, GotEvents<CancelableRequest<T>>> {
	json<TReturnType extends object>(): CancelableRequest<TReturnType>;
	buffer(): CancelableRequest<Buffer>;
	text(): CancelableRequest<string>;
}
