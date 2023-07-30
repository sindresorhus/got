import type {Buffer} from 'node:buffer';
import type PCancelable from 'p-cancelable';
import {RequestError} from '../core/errors.js';
import type Request from '../core/index.js'; // eslint-disable-line import/no-duplicates
import {type RequestEvents} from '../core/index.js'; // eslint-disable-line import/no-duplicates -- It's not allowed to combine these imports. The rule is incorrect.
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

// TODO: Make this a `type`.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- TS cannot handle this being a `type` for some reason.
export interface CancelableRequest<T extends Response | Response['body'] = Response['body']> extends PCancelable<T>, RequestEvents<CancelableRequest<T>> {
	/**
	A shortcut method that gives a Promise returning a JSON object.

	It is semantically the same as settings `options.resolveBodyOnly` to `true` and `options.responseType` to `'json'`.
	*/
	json: <ReturnType>() => CancelableRequest<ReturnType>;

	/**
	A shortcut method that gives a Promise returning a [Buffer](https://nodejs.org/api/buffer.html).

	It is semantically the same as settings `options.resolveBodyOnly` to `true` and `options.responseType` to `'buffer'`.
	*/
	buffer: () => CancelableRequest<Buffer>;

	/**
	A shortcut method that gives a Promise returning a string.

	It is semantically the same as settings `options.resolveBodyOnly` to `true` and `options.responseType` to `'text'`.
	*/
	text: () => CancelableRequest<string>;
}
