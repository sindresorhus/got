import is from '@sindresorhus/is';
import {Timings} from '@szmarczak/http-timer';
import {Response, NormalizedOptions} from './utils/types';
import {TimeoutError as TimedOutError} from './utils/timed-out';

export class GotError extends Error {
	code?: string;
	readonly options: NormalizedOptions;

	constructor(message: string, error: Partial<Error & {code?: string}>, options: NormalizedOptions) {
		super(message);
		Error.captureStackTrace(this, this.constructor);
		this.name = 'GotError';

		if (!is.undefined(error.code)) {
			this.code = error.code;
		}

		Object.defineProperty(this, 'options', {
			value: options
		});

		// Recover the original stacktrace
		if (!is.undefined(error.stack)) {
			const indexOfMessage = this.stack.indexOf(this.message) + this.message.length;
			const thisStackTrace = this.stack.slice(indexOfMessage).split('\n').reverse();
			const errorStackTrace = error.stack.slice(error.stack.indexOf(error.message) + error.message.length).split('\n').reverse();

			// Remove duplicated traces
			while (errorStackTrace.length !== 0 && errorStackTrace[0] === thisStackTrace[0]) {
				thisStackTrace.shift();
			}

			this.stack = `${this.stack.slice(0, indexOfMessage)}${thisStackTrace.reverse().join('\n')}${errorStackTrace.reverse().join('\n')}`;
		}
	}
}

export class CacheError extends GotError {
	constructor(error: Error, options: NormalizedOptions) {
		super(error.message, error, options);
		this.name = 'CacheError';
	}
}

export class RequestError extends GotError {
	constructor(error: Error, options: NormalizedOptions) {
		super(error.message, error, options);
		this.name = 'RequestError';
	}
}

export class ReadError extends GotError {
	constructor(error: Error, options: NormalizedOptions) {
		super(error.message, error, options);
		this.name = 'ReadError';
	}
}

export class ParseError extends GotError {
	readonly response: Response;

	constructor(error: Error, response: Response, options: NormalizedOptions) {
		super(`${error.message} in "${options.url.toString()}"`, error, options);
		this.name = 'ParseError';

		Object.defineProperty(this, 'response', {
			value: response
		});
	}
}

export class HTTPError extends GotError {
	readonly response: Response;

	constructor(response: Response, options: NormalizedOptions) {
		const {statusCode, statusMessage} = response;

		super(`Response code ${statusCode} (${statusMessage})`, {}, options);
		this.name = 'HTTPError';

		Object.defineProperty(this, 'response', {
			value: response
		});
	}
}

export class MaxRedirectsError extends GotError {
	readonly response: Response;

	constructor(response: Response, maxRedirects: number, options: NormalizedOptions) {
		super(`Redirected ${maxRedirects} times. Aborting.`, {}, options);
		this.name = 'MaxRedirectsError';

		Object.defineProperty(this, 'response', {
			value: response
		});
	}
}

export class UnsupportedProtocolError extends GotError {
	constructor(options: NormalizedOptions) {
		super(`Unsupported protocol "${options.url.protocol}"`, {}, options);
		this.name = 'UnsupportedProtocolError';
	}
}

export class TimeoutError extends GotError {
	timings: Timings;
	event: string;

	constructor(error: TimedOutError, timings: Timings, options: NormalizedOptions) {
		super(error.message, error, options);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

export {CancelError} from 'p-cancelable';
