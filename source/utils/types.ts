import {IncomingMessage} from 'http';
import {RequestOptions} from 'https';
import {PCancelable} from 'p-cancelable';
import {Hooks} from '../known-hook-events';

export type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'TRACE' | 'get' | 'put' | 'head' | 'delete' | 'options' | 'trace';

export type NextFunction = (error?: Error | string) => void;

export type IterateFunction = (options: Options) => void;

export interface Instance {
	methods?: Method[];
	options?: Options;
	handler?: (options: Options, callback: NextFunction) => void;
}

export interface InterfaceWithDefaults extends Instance {
	defaults: {
		handler: (options: Options, callback: NextFunction | IterateFunction) => void;
		options: Options;
	};
}

export interface Options extends RequestOptions {
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	encoding?: BufferEncoding | null;
	method?: Method;
	// TODO: Remove this once TS migration is complete and all options are defined.
	[key: string]: unknown;
}

export interface CancelableRequest<T extends IncomingMessage> extends PCancelable<T> {
	on(name: string, listener: () => void): CancelableRequest<T>;
	json(): CancelableRequest<T>;
	buffer(): CancelableRequest<T>;
	text(): CancelableRequest<T>;
}
