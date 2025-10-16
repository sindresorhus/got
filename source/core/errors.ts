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
export class RequestError<T = unknown> extends Error {
	override name = 'RequestError';
	code = 'ERR_GOT_REQUEST_ERROR';
	input?: string;
	override stack!: string;
	declare readonly options: Options;
	readonly response?: Response<T>;
	readonly request?: Request;
	readonly timings?: Timings;

	constructor(message: string, error: Partial<Error & {code?: string}>, self: Request | Options) {
		super(message, {cause: error});
		Error.captureStackTrace(this, this.constructor);

		if (error.code) {
			this.code = error.code;
		}

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
	override name = 'MaxRedirectsError';
	override code = 'ERR_TOO_MANY_REDIRECTS';
	declare readonly response: Response;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(request: Request) {
		super(`Redirected ${request.options.maxRedirects} times. Aborting.`, {}, request);
	}
}

/**
An error to be thrown when the server response code is not 2xx nor 3xx if `options.followRedirect` is `true`, but always except for 304.
Includes a `response` property.
*/
// TODO: Change `HTTPError<T = any>` to `HTTPError<T = unknown>` in the next major version to enforce type usage.
// eslint-disable-next-line @typescript-eslint/naming-convention
export class HTTPError<T = any> extends RequestError<T> {
	override name = 'HTTPError';
	override code = 'ERR_NON_2XX_3XX_RESPONSE';
	declare readonly response: Response<T>;
	declare readonly request: Request;
	declare readonly timings: Timings;

	constructor(response: PlainResponse) {
		super(`Request failed with status code ${response.statusCode} (${response.statusMessage!}): ${response.request.options.method} ${response.request.options.url!.toString()}`, {}, response.request);
	}
}

/**
An error to be thrown when a cache method fails.
For example, if the database goes down or there's a filesystem error.
*/
export class CacheError extends RequestError {
	override name = 'CacheError';
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		if (this.code === 'ERR_GOT_REQUEST_ERROR') {
			this.code = 'ERR_CACHE_ACCESS';
		}
	}
}

/**
An error to be thrown when the request body is a stream and an error occurs while reading from that stream.
*/
export class UploadError extends RequestError {
	override name = 'UploadError';
	declare readonly request: Request;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		if (this.code === 'ERR_GOT_REQUEST_ERROR') {
			this.code = 'ERR_UPLOAD';
		}
	}
}

/**
An error to be thrown when the request is aborted due to a timeout.
Includes an `event` and `timings` property.
*/
export class TimeoutError extends RequestError {
	override name = 'TimeoutError';
	declare readonly request: Request;
	override readonly timings: Timings;
	readonly event: string;

	constructor(error: TimedOutTimeoutError, timings: Timings, request: Request) {
		super(error.message, error, request);
		this.event = error.event;
		this.timings = timings;
	}
}

/**
An error to be thrown when reading from response stream fails.
*/
export class ReadError extends RequestError {
	override name = 'ReadError';
	declare readonly request: Request;
	declare readonly response: Response;
	declare readonly timings: Timings;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);
		if (this.code === 'ERR_GOT_REQUEST_ERROR') {
			this.code = 'ERR_READING_RESPONSE_STREAM';
		}
	}
}

/**
An error which always triggers a new retry when thrown.
*/
export class RetryError extends RequestError {
	override name = 'RetryError';
	override code = 'ERR_RETRYING';

	constructor(request: Request) {
		super('Retrying', {}, request);
	}
}

/**
An error to be thrown when the request is aborted by AbortController.
*/
export class AbortError extends RequestError {
	override name = 'AbortError';
	override code = 'ERR_ABORTED';

	constructor(request: Request) {
		super('This operation was aborted.', {}, request);
	}
}
