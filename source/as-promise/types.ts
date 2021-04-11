import * as PCancelable from 'p-cancelable';
import {RequestError} from '../core/errors';
// eslint-disable-next-line import/no-duplicates
import type Request from '../core';
// eslint-disable-next-line import/no-duplicates
import type {RequestEvents} from '../core';
import type {Response} from '../core/response';

/**
An error to be thrown when the request is aborted with `.cancel()`.
*/
export class CancelError extends RequestError {
	declare readonly response: Response;

	constructor(request: Request) {
		super('Promise was canceled', {}, request);
		this.name = 'CancelError';
	}

	get isCanceled() {
		return true;
	}
}

export interface CancelableRequest<T extends Response | Response['body'] = Response['body']> extends PCancelable<T>, RequestEvents<CancelableRequest<T>> {
	json: <ReturnType>() => CancelableRequest<ReturnType>;
	buffer: () => CancelableRequest<Buffer>;
	text: () => CancelableRequest<string>;
}
