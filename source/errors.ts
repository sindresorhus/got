import urlLib from 'url';
import http from 'http';
import is from '@sindresorhus/is';
import {Timings} from '@szmarczak/http-timer';
import {Response, Options} from './utils/types';
import {TimeoutError as TimedOutError} from './utils/timed-out';

type ErrorWithCode = (Error & {code?: string}) | {code?: string};

export class GotError extends Error {
	code?: string;

	options: Options;

	constructor(message: string, error: ErrorWithCode, options: Options) {
		super(message);
		Error.captureStackTrace(this, this.constructor);
		this.name = 'GotError';

		if (!is.undefined(error.code)) {
			this.code = error.code;
		}

		Object.defineProperty(this, 'options', {
			value: options
		});
	}
}

export class CacheError extends GotError {
	constructor(error: Error, options: Options) {
		super(error.message, error, options);
		this.name = 'CacheError';
	}
}

export class RequestError extends GotError {
	constructor(error: Error, options: Options) {
		super(error.message, error, options);
		this.name = 'RequestError';
	}
}

export class ReadError extends GotError {
	constructor(error: Error, options: Options) {
		super(error.message, error, options);
		this.name = 'ReadError';
	}
}

export class ParseError extends GotError {
	response: Response;

	constructor(error: Error, response: Response, options: Options) {
		super(`${error.message} in "${urlLib.format(options)}"`, error, options);
		this.name = 'ParseError';

		Object.defineProperty(this, 'response', {
			value: response
		});
	}
}

export class HTTPError extends GotError {
	response: Response;

	constructor(response: Response, options: Options) {
		const {statusCode} = response;
		let {statusMessage} = response;

		if (statusMessage) {
			statusMessage = statusMessage.replace(/\r?\n/g, ' ').trim();
		} else {
			statusMessage = http.STATUS_CODES[statusCode];
		}

		super(`Response code ${statusCode} (${statusMessage})`, {}, options);
		this.name = 'HTTPError';

		Object.defineProperty(this, 'response', {
			value: response
		});
	}
}

export class MaxRedirectsError extends GotError {
	response: Response;

	constructor(response: Response, options: Options) {
		super('Redirected 10 times. Aborting.', {}, options);
		this.name = 'MaxRedirectsError';

		Object.defineProperty(this, 'response', {
			value: response
		});
	}
}

export class UnsupportedProtocolError extends GotError {
	constructor(options: Options) {
		super(`Unsupported protocol "${options.protocol}"`, {}, options);
		this.name = 'UnsupportedProtocolError';
	}
}

export class TimeoutError extends GotError {
	timings: Timings;

	event: string;

	constructor(error: TimedOutError, timings: Timings, options: Options) {
		super(error.message, {code: 'ETIMEDOUT'}, options);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

export {CancelError} from 'p-cancelable';
