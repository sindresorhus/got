import type PCancelable from 'p-cancelable';
import {RequestError} from '../core/errors.js';
import type Request from '../core/index.js';
import {type RequestEvents} from '../core/index.js';
import type {Response} from '../core/response.js';

/**
An error to be thrown when the request is aborted with `.cancel()`.
*/
export class CancelError extends RequestError {
	declare readonly response: Response;

	constructor(request: Request) {
		super('Promise was canceled', {}, request);
		this.name = 'CancelError';
		this.code = 'ERR_CANCELED';
	}

	/**
	Whether the promise is canceled.
	*/
	get isCanceled() {
		return true;
	}
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Internal recursive shape requires interface; public API remains a type alias.
interface CancelableRequestShape<T extends Response | Response['body'] = Response['body']> extends RequestEvents<CancelableRequest<T>> {
	/**
	A shortcut method that gives a Promise returning a JSON object.

	It is semantically the same as settings `options.resolveBodyOnly` to `true` and `options.responseType` to `'json'`.
	*/
	json: <ReturnType>() => CancelableRequest<ReturnType>;

	/**
	A shortcut method that gives a Promise returning a [Uint8Array](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array).

	It is semantically the same as settings `options.resolveBodyOnly` to `true` and `options.responseType` to `'buffer'`.
	*/
	buffer: () => CancelableRequest<Uint8Array>;

	/**
	A shortcut method that gives a Promise returning a string.

	It is semantically the same as settings `options.resolveBodyOnly` to `true` and `options.responseType` to `'text'`.
	*/
	text: () => CancelableRequest<string>;
}

// This is intentionally a type alias to keep structural typing predictable.
// Augmenting it via interface merging is not supported.
export type CancelableRequest<T extends Response | Response['body'] = Response['body']> = PCancelable<T> & CancelableRequestShape<T>;
