import {IncomingMessage} from 'http';
import {RequestOptions} from 'https';
import {Readable as ReadableStream} from 'stream';
import PCancelable from 'p-cancelable';
import {Hooks} from '../known-hook-events';

export type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'TRACE' | 'get' | 'put' | 'head' | 'delete' | 'options' | 'trace';
export type ErrorCode = 'ETIMEDOUT' | 'ECONNRESET' | 'EADDRINUSE' | 'ECONNREFUSED' | 'EPIPE' | 'ENOTFOUND' | 'ENETUNREACH' | 'EAI_AGAIN';
export type StatusCode = 408 | 413 | 429 | 500 | 502 | 503 | 504;

export type NextFunction = (error?: Error | string) => void;

export type IterateFunction = (options: Options) => void;

export interface Response extends IncomingMessage {
	body: string | Buffer;
	statusCode: number;
}

export interface Timings {
	start: number;
	socket: number | null;
	lookup: number | null;
	connect: number | null;
	upload: number | null;
	response: number | null;
	end: number | null;
	error: number | null;
	phases: {
		wait: number | null;
		dns: number | null;
		tcp: number | null;
		request: number | null;
		firstByte: number | null;
		download: number | null;
		total: number | null;
	};
}

export interface Instance {
	methods: Method[];
	options: Partial<Options>;
	handler: (options: Options, callback: NextFunction) => void;
}

export interface InterfaceWithDefaults extends Instance {
	defaults: {
		handler: (options: Options, callback: NextFunction | IterateFunction) => void;
		options: Options;
	};
}

interface RetryOption {
	retries?: ((retry: number, error: Error) => number) | number;
	methods?: Method[];
	statusCodes?: StatusCode[];
	maxRetryAfter?: number;
	errorCodes?: ErrorCode[];
}

export interface MergedOptions extends Options {
	retry: RetryOption;
}

export interface Options extends RequestOptions {
	host: string;
	body: string | Buffer | ReadableStream;
	hostname?: string;
	path?: string;
	socketPath?: string;
	protocol?: string;
	href?: string;
	options?: Partial<Options>;
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	encoding?: BufferEncoding | null;
	method?: Method;
	retry?: number | RetryOption;
	throwHttpErrors?: boolean;
	// TODO: Remove this once TS migration is complete and all options are defined.
	[key: string]: unknown;
}

export interface CancelableRequest<T extends IncomingMessage> extends PCancelable<T> {
	on(name: string, listener: () => void): CancelableRequest<T>;
	json(): CancelableRequest<T>;
	buffer(): CancelableRequest<T>;
	text(): CancelableRequest<T>;
}
