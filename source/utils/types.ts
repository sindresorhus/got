import http, {ClientRequest, IncomingMessage} from 'http';
import https from 'https';
import {Readable as ReadableStream} from 'stream';
import PCancelable from 'p-cancelable';
import {CookieJar} from 'tough-cookie';
import {StorageAdapter} from 'cacheable-request';
import {Omit} from 'type-fest';
import CacheableLookup from 'cacheable-lookup';
import Keyv from 'keyv';
import {Timings} from '@szmarczak/http-timer/dist';
import {Hooks} from '../known-hook-events';
import {GotError, ParseError, HTTPError, MaxRedirectsError} from '../errors';
import {ProxyStream} from '../as-stream';

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

export type StatusCode =
	| 408
	| 413
	| 429
	| 500
	| 502
	| 503
	| 504;

export type ResponseType = 'json' | 'buffer' | 'text';

export interface Response extends IncomingMessage {
	body: Buffer | string | any;
	statusCode: number;
	fromCache?: boolean;
	isFromCache?: boolean;
	req: ClientRequest;
	requestUrl: string;
	retryCount: number;
	timings: Timings;
	redirectUrls: string[];
	request: { options: NormalizedOptions };
}

export type RetryFunction = (retry: number, error: Error | GotError | ParseError | HTTPError | MaxRedirectsError) => number;

export type HandlerFunction = <T extends ProxyStream | CancelableRequest<Response>>(options: NormalizedOptions, next: (options: NormalizedOptions) => T) => T;

export interface RetryOption {
	retries?: RetryFunction | number;
	methods?: Method[];
	statusCodes?: StatusCode[];
	errorCodes?: ErrorCode[];
	maxRetryAfter?: number;
}

export interface NormalizedRetryOptions {
	retries: RetryFunction;
	methods: ReadonlySet<Method>;
	statusCodes: ReadonlySet<StatusCode>;
	errorCodes: ReadonlySet<ErrorCode>;
	maxRetryAfter: number;
}

export type RequestFunction = typeof https.request;

export interface AgentByProtocol {
	http: http.Agent;
	https: https.Agent;
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

// The library overrides the type definition of `agent`, `host` and `timeout`.
export interface Options extends Omit<https.RequestOptions, 'agent' | 'timeout' | 'host'> {
	host?: string;
	body?: string | Buffer | ReadableStream;
	hostname?: string;
	path?: string;
	socketPath?: string;
	protocol?: string;
	href?: string;
	options?: Partial<Options>;
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	stream?: boolean;
	encoding?: BufferEncoding | null;
	method?: Method;
	retry?: number | RetryOption | NormalizedRetryOptions;
	throwHttpErrors?: boolean;
	cookieJar?: CookieJar;
	request?: RequestFunction;
	agent?: http.Agent | https.Agent | boolean | AgentByProtocol;
	gotTimeout?: number | Delays;
	cache?: string | StorageAdapter | false;
	headers?: Record<string, string | string[]>;
	mutableDefaults?: boolean;
	responseType?: ResponseType;
	resolveBodyOnly?: boolean;
	followRedirect?: boolean;
	baseUrl?: URL | string;
	timeout?: number | Delays;
	dnsCache?: Keyv | false;
	url?: URL | string;
	searchParams?: Record<string, string | number | boolean | null> | URLSearchParams | string;
	/*
	Deprecated
	 */
	query?: Options['searchParams'];
	useElectronNet?: boolean;
	form?: boolean;
	json?: boolean;
}

export interface NormalizedOptions extends Omit<Options, 'timeout' | 'dnsCache' | 'retry'> {
	headers: Record<string, string | string[]>;
	hooks: Hooks;
	gotTimeout: Required<Delays>;
	retry: NormalizedRetryOptions;
	lookup?: CacheableLookup['lookup'];
	readonly baseUrl: string;
	path: string;
	hostname: string;
	host: string;
}

export interface Defaults {
	methods?: Method[];
	options?: Partial<Options>;
	handler?: HandlerFunction;
	mutableDefaults?: boolean;
}

export interface CancelableRequest<T extends IncomingMessage> extends PCancelable<T> {
	on(name: string, listener: () => void): CancelableRequest<T>;
	json(): CancelableRequest<T>;
	buffer(): CancelableRequest<T>;
	text(): CancelableRequest<T>;
}
