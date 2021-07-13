import is from '@sindresorhus/is';
import type {Timings} from '@szmarczak/http-timer';
import type Options from './options.js';
import type {TimeoutError as TimedOutTimeoutError} from './timed-out.js';
import type {PlainResponse, Response} from './response.js';
import type Request from './index.js';

type Error = NodeJS.ErrnoException;

// A hacky check to prevent circular references.
function isRequest(x: unknown): x is Request {
	return is.object(x) && '_onResponse' in x;
}

/**
An error to be thrown when a request fails.
Contains a `code` property with error class code, like `ECONNREFUSED`.
*/
export class RequestError extends Error {
	input?: string;

	code: string;
	stack!: string;
	declare readonly options: Options;
	readonly response?: Response;
	readonly request?: Request;
	readonly timings?: Timings;

	constructor(message: string, error: Partial<Error & {code?: string}>, self: Request | Options) {
		super(message);
		Error.captureStackTrace(this, this.constructor);

		this.name = 'RequestError';
		this.code = error.code ?? 'ERR_GOT_REQUEST_ERROR';
		this.input = (error as any).input;

		if (isRequest(self)) {
			Object.defineProperty(this, 'request', {
				enumerable: false,
				value: self,
			});

			Object.defineProperty(this, 'response', {
				enumerable: false,
				value: self.response,
			});

			this.options = self.options;
		} else {
			this.options = self;
		}

		this.timings = this.request?.timings;

		// Recover the original stacktrace
		if (is.string(error.stack) && is.string(this.stack)) {
			const indexOfMessage = this.stack.indexOf(this.message) + this.message.length;
			const thisStackTrace = this.stack.slice(indexOfMessage).split('\n').reverse();
			const errorStackTrace = error.stack.slice(error.stack.indexOf(error.message!) + error.message!.length).split('\n').reverse();

			// Remove duplicated traces
			while (errorStackTrace.length > 0 && errorStackTrace[0] === thisStackTrace[0]) {
				thisStackTrace.shift();
			}

			this.stack = `${this.stack.slice(0, indexOfMessage)}${thisStackTrace.reverse().join('\n')}${errorStackTrace.reverse().join('\n')}`;
		}
	}
}

/**
An error to be thrown when the server redirects you more than ten times.
Includes a `response` property.
*/
export class MaxRedirectsError extends RequestError {
	declare readonly response: Response;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(request: Request) {
		super(`Redirected ${request.options.maxRedirects} times. Aborting.`, {}, request);
		this.name = 'MaxRedirectsError';
		this.code = 'ERR_TOO_MANY_REDIRECTS';
	}
}

/**
An error to be thrown when the server response code is not 2xx nor 3xx if `options.followRedirect` is `true`, but always except for 304.
Includes a `response` property.
*/
export class HTTPError extends RequestError {
	declare readonly response: Response;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(response: PlainResponse) {
		super(`Response code ${response.statusCode} (${response.statusMessage!})`, {}, response.request);
		this.name = 'HTTPError';
		this.code = 'ERR_NON_2XX_3XX_RESPONSE';
	}
}

/**
An error to be thrown when a cache method fails.
For example, if the database goes down or there's a filesystem error.
*/
export class CacheError extends RequestError {
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'CacheError';
		this.code = this.code === 'ERR_GOT_REQUEST_ERROR' ? 'ERR_CACHE_ACCESS' : this.code;
	}
}

/**
An error to be thrown when the request body is a stream and an error occurs while reading from that stream.
*/
export class UploadError extends RequestError {
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'UploadError';
		this.code = this.code === 'ERR_GOT_REQUEST_ERROR' ? 'ERR_UPLOAD' : this.code;
	}
}

/**
An error to be thrown when the request is aborted due to a timeout.
Includes an `event` and `timings` property.
*/
export class TimeoutError extends RequestError {
	declare readonly request: Request;
	readonly timings: Timings;
	readonly event: string;

	constructor(error: TimedOutTimeoutError, timings: Timings, request: Request) {
		super(error.message, error, request);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

/**
An error to be thrown when reading from response stream fails.
*/
export class ReadError extends RequestError {
	declare readonly request: Request;
	declare readonly response: Response;
	declare readonly timings: Timings;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		this.name = 'ReadError';
		this.code = this.code === 'ERR_GOT_REQUEST_ERROR' ? 'ERR_READING_RESPONSE_STREAM' : this.code;
	}
}

/**
An error which always triggers a new retry when thrown.
*/
export class RetryError extends RequestError {
	constructor(request: Request) {
		super('Retrying', {}, request);
		this.name = 'RetryError';
		this.code = 'ERR_RETRYING';
	}
}
