import {IncomingMessage} from 'http';
import {RequestOptions} from 'https';
import {Readable} from 'stream';
import {EventEmitter} from 'events';
import {PCancelable} from 'p-cancelable';
import {Hooks} from '../known-hook-events';
import {defaults} from '..';

export type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'TRACE' | 'get' | 'put' | 'head' | 'delete' | 'options' | 'trace';

export type NextFunction = (error?: Error | string) => void;

export type IterateFunction = (options: Options) => void;

export type Defaults = typeof defaults;

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

interface RetryDescriptor {
	retries: ((retry: number, error: Error) => number) | number;
}

export interface Options extends RequestOptions {
	host: string;
	body: string | Buffer | Readable;
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
	retry?: RetryDescriptor; // @todo Documentation says this might be a number, need to confirm from a maintainer.
	throwHttpErrors?: boolean;
	// TODO: Remove this once TS migration is complete and all options are defined.
	[key: string]: unknown;
}

export interface RequestEmitter extends EventEmitter {
	abort: () => void;
}


export interface CancelableRequest<T extends IncomingMessage> extends PCancelable<T> {
	on(name: string, listener: () => void): CancelableRequest<T>;
	json(): CancelableRequest<T>;
	buffer(): CancelableRequest<T>;
	text(): CancelableRequest<T>;
}
