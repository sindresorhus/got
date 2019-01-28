import {IncomingMessage} from 'http';
import {RequestOptions} from 'https';
import {PCancelable} from 'p-cancelable';
import {Hooks} from '../known-hook-events';

export interface Options extends RequestOptions {
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	encoding?: BufferEncoding | null;
	method?: string;
	[ key: string ]: unknown | Options;
}

export interface CancelableRequest<T extends IncomingMessage> extends PCancelable<T> {
	on(name: string, listener: () => void): CancelableRequest<T>;
	json(): CancelableRequest<T>;
	buffer(): CancelableRequest<T>;
	text(): CancelableRequest<T>;
}
