import is from '@sindresorhus/is';
import stripUrlAuth from './utils/strip-url-auth.js';
import type {StandardSchemaV1Issue} from './standard-schema.js';
import type {Timings} from './utils/timer.js';
import type Options from './options.js';
import type {TimeoutError as TimedOutTimeoutError} from './timed-out.js';
import type {PlainResponse, RequestErrorResponse} from './response.js';
import type Request from './index.js';

type Error = NodeJS.ErrnoException;

export const normalizeError = (error: unknown): Error => {
	if (error instanceof globalThis.Error) {
		return error;
	}

	if (is.object(error)) {
		const errorLike = error as Partial<Error & {code?: string; input?: string}>;
		const message = typeof errorLike.message === 'string' ? errorLike.message : 'Non-error object thrown';
		const normalizedError = new globalThis.Error(message, {cause: error}) as Error & {code?: string; input?: string};

		if (typeof errorLike.stack === 'string') {
			normalizedError.stack = errorLike.stack;
		}

		if (typeof errorLike.code === 'string') {
			normalizedError.code = errorLike.code;
		}

		if (typeof errorLike.input === 'string') {
			normalizedError.input = errorLike.input;
		}

		return normalizedError;
	}

	return new globalThis.Error(String(error));
};

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
	/**
	The response that caused the error, if any. The body and raw body are absent when Got did not read the response body.
	*/
	readonly response?: RequestErrorResponse<T>;
	readonly request?: Request;
	readonly timings?: Timings;

	constructor(message: string, error: unknown, self: Request | Options, response?: PlainResponse) {
		super(message, {cause: error});

		// The stack is trimmed here so that the frames inside `got` do not appear in the trace the
		// caller sees. `unicorn/no-useless-error-capture-stack-trace` assumes the call is redundant
		// for a subclass of `Error`, which is not the case here.
		// eslint-disable-next-line unicorn/no-useless-error-capture-stack-trace
		Error.captureStackTrace(this, this.constructor);

		// The cause is kept as thrown, so it can be any value. Only an object can carry details.
		const errorLike = is.object(error) ? error as Error & {code?: string; input?: string; stack?: string} : undefined;

		if (typeof errorLike?.code === 'string' && errorLike.code !== '') {
			this.code = errorLike.code;
		}

		this.input = typeof errorLike?.input === 'string' ? errorLike.input : undefined;

		if (isRequest(self)) {
			Object.defineProperties(this, {
				request: {
					enumerable: false,
					value: self,
				},
				response: {
					enumerable: false,
					value: response ?? self.response,
				},
			});

			this.options = self.options;
		} else {
			this.options = self;
		}

		this.timings = this.request?.timings;

		// Recover the original stacktrace
		if (is.string(errorLike?.stack) && is.string(this.stack)) {
			// Both stacks start with a `name: message` header, and both headers are rebuilt below
			// by dropping everything before this point. A multi-line message spans several lines,
			// so the whole message is the boundary. A message that is empty or absent matches at
			// zero and would leave the header in the frames, so the first newline is the boundary.
			// A message that is not in its stack, such as one changed after the stack was read, has no
			// boundary at all.
			const frameStart = (stack: string, message: string | undefined): number => {
				if (!message) {
					return stack.indexOf('\n');
				}

				// Match the complete header suffix, since a message can also occur inside the name.
				const headerSuffix = `${message}\n`;
				const headerStart = `${stack}\n`.indexOf(headerSuffix);
				return headerStart === -1 ? -1 : headerStart + headerSuffix.length - 1;
			};

			const headerEnd = frameStart(this.stack, this.message);
			const thisStackTrace = (headerEnd === -1 ? '' : this.stack.slice(headerEnd)).split('\n').toReversed();
			const causeStart = frameStart(errorLike.stack, errorLike.message);
			const originalStack = is.string(errorLike.message) && causeStart !== -1
				? errorLike.stack.slice(causeStart)
				: `\n${errorLike.stack}`;
			const errorStackTrace = originalStack.split('\n').toReversed();

			// Remove duplicated traces
			let sharedFrameCount = 0;
			while (sharedFrameCount < thisStackTrace.length && sharedFrameCount < errorStackTrace.length && errorStackTrace[sharedFrameCount] === thisStackTrace[sharedFrameCount]) {
				sharedFrameCount++;
			}

			const frames = `${thisStackTrace.slice(sharedFrameCount).toReversed().join('\n')}${errorStackTrace.toReversed().join('\n')}`;

			// A subclass sets `name` only after `super()` returns, so building the header here
			// would label every subclass as a plain `RequestError`. Read the names on access
			// instead, while still honouring an assigned stack the way `Error` does.
			Object.defineProperty(this, 'stack', {
				configurable: true,
				enumerable: false,
				get: () => `${this.name}: ${this.message}${frames}`,
				set(value: unknown) {
					Object.defineProperty(this, 'stack', {
						configurable: true,
						enumerable: false,
						writable: true,
						value,
					});
				},
			});
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
	declare readonly response: RequestErrorResponse;
	declare readonly request: Request;

	constructor(request: Request) {
		super(`Redirected ${request.options.maxRedirects} times. Aborting.`, {}, request);
	}
}

/**
An error to be thrown when the server response code is not 2xx nor 3xx if `options.followRedirect` is `true`, but always except for 304.
Includes a `response` property.
*/
// eslint-disable-next-line @typescript-eslint/naming-convention
export class HTTPError<T = unknown> extends RequestError<T> {
	override name = 'HTTPError';
	override code = 'ERR_NON_2XX_3XX_RESPONSE';
	declare readonly response: RequestErrorResponse<T>;
	declare readonly request: Request;

	constructor(response: PlainResponse) {
		super(`Request failed with status code ${response.statusCode} (${response.statusMessage!}): ${response.request.options.method} ${stripUrlAuth(response.request.options.url!)}`, {}, response.request, response);
	}
}

/**
An error to be thrown when a cache method fails.
For example, if the database goes down or there's a filesystem error.
*/
export class CacheError extends RequestError {
	override name = 'CacheError';
	override code = 'ERR_CACHE_ACCESS';
	declare readonly request: Request;

	constructor(error: unknown, request: Request) {
		super(normalizeError(error).message, error, request);
	}
}

/**
An error to be thrown when the request body is a stream and an error occurs while reading from that stream.
*/
export class UploadError extends RequestError {
	override name = 'UploadError';
	override code = 'ERR_UPLOAD';
	declare readonly request: Request;

	constructor(error: unknown, request: Request) {
		super(normalizeError(error).message, error, request);
	}
}

/**
An error to be thrown when the request is aborted due to a timeout.
Includes an `event` and `timings` property.
*/
export class TimeoutError extends RequestError {
	override name = 'TimeoutError';
	override code = 'ETIMEDOUT';
	declare readonly request: Request;
	override readonly timings: Timings;
	readonly event: string;

	constructor(error: TimedOutTimeoutError, timings: Timings, request: Request) {
		super(error.message, error, request);
		// `AbortSignal.timeout()` reports a `DOMException`, which names no phase.
		this.event = error.event ?? 'request';
		this.timings = timings;
	}
}

/**
An error to be thrown when reading from response stream fails.
*/
export class ReadError extends RequestError {
	override name = 'ReadError';
	override code = 'ERR_READING_RESPONSE_STREAM';
	declare readonly request: Request;
	// A request may have no response yet, or reading can fail before its body has been captured.
	declare readonly response?: RequestErrorResponse;

	constructor(error: Error, request: Request) {
		super(error.message, error, request);

		if (error.code === 'ECONNRESET' || error.code === 'ERR_HTTP_CONTENT_LENGTH_MISMATCH') {
			this.code = error.code;
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
		if (request.options?.signal?.aborted) {
			this.cause = request.options.signal.reason;
		}
	}
}

/**
An error to be thrown when the response body does not match the [Standard Schema](https://standardschema.dev) validator passed to `.json(schema)`. Includes an `issues` property with the issues from the schema. Each issue has a `message` and an optional `path`.

It intentionally does not extend `RequestError`, because the request succeeded. The user-provided schema did not accept the data, so it has no `code`, `options`, `request`, `response` or `timings` property, and it is not passed to `beforeError` hooks.

@example
```
import got, {SchemaValidationError} from 'got';
import {z} from 'zod';

const userSchema = z.object({name: z.string()});

try {
	const user = await got('https://example.com/user').json(userSchema);
	console.log(user.name);
} catch (error) {
	if (error instanceof SchemaValidationError) {
		console.error(error.issues);
	} else {
		throw error;
	}
}
```
*/
export class SchemaValidationError extends Error {
	override name = 'SchemaValidationError';
	readonly issues: readonly StandardSchemaV1Issue[];

	constructor(issues: readonly StandardSchemaV1Issue[]) {
		super('Response schema validation failed');
		this.issues = issues;
	}
}
