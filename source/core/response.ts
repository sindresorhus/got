import {Buffer} from 'node:buffer';
import type {IncomingMessageWithTimings, Timings} from './utils/timer.js';
import {normalizeError, RequestError} from './errors.js';
import stripUrlAuth from './utils/strip-url-auth.js';
import type {ParseJsonFunction, ResponseType} from './options.js';
import type Request from './index.js';

const decodedBodyCache = new WeakMap<PlainResponse, string>();
const redirectDecisions = new WeakMap<PlainResponse, {predicate: (response: PlainResponse) => boolean; follow: boolean}>();
// TextDecoder strips a leading byte order mark, which Buffer#toString keeps.
const bomStrippingDecoders = new Map([
	['utf8', new TextDecoder()],
	['utf16le', new TextDecoder('utf-16le')],
]);

const normalizeEncoding = (encoding?: BufferEncoding): string => (encoding ?? 'utf8').toLowerCase().replace('-', '').replace('ucs2', 'utf16le');

export const isUtf8Encoding = (encoding?: BufferEncoding): boolean => normalizeEncoding(encoding) === 'utf8';

export const decodeUint8Array = (data: Uint8Array, encoding?: BufferEncoding): string => bomStrippingDecoders.get(normalizeEncoding(encoding))?.decode(data) ?? Buffer.from(data).toString(encoding);

export type PlainResponse = {
	/**
	The original request URL.
	*/
	requestUrl: URL;

	/**
	The redirect URLs.
	*/
	redirectUrls: URL[];

	/**
	- `options` - The Got options that were set on this request.

	__Note__: This is not a [http.ClientRequest](https://nodejs.org/api/http.html#http_class_http_clientrequest).
	*/
	request: Request;

	/**
	The remote IP address.

	This is hopefully a temporary limitation, see [lukechilds/cacheable-request#86](https://web.archive.org/web/20220804165050/https://github.com/jaredwray/cacheable-request/issues/86).

	__Note__: Not available when the response is cached.
	*/
	ip?: string;

	/**
	Whether the response was retrieved from the cache.
	*/
	isFromCache: boolean;

	/**
	The status code of the response.
	*/
	statusCode: number;

	/**
	The request URL or the final URL after redirects.
	*/
	url: string;

	/**
	The object contains the following properties:

	- `start` - Time when the request started.
	- `socket` - Time when a socket was assigned to the request.
	- `lookup` - Time when the DNS lookup finished.
	- `connect` - Time when the socket successfully connected.
	- `secureConnect` - Time when the socket securely connected.
	- `upload` - Time when the request finished uploading.
	- `response` - Time when the request fired `response` event.
	- `end` - Time when the response fired `end` event.
	- `error` - Time when the request fired `error` event.
	- `abort` - Time when the request fired `abort` event.
	- `phases`
		- `wait` - `timings.socket - timings.start`
		- `dns` - `timings.lookup - timings.socket`
		- `tcp` - `timings.connect - timings.lookup`
		- `tls` - `timings.secureConnect - timings.connect`
		- `request` - `timings.upload - (timings.secureConnect || timings.connect)`
		- `firstByte` - `timings.response - timings.upload`
		- `download` - `timings.end - timings.response`
		- `total` - `(timings.end || timings.error || timings.abort) - timings.start`

	If something has not been measured yet, it will be `undefined`.

	The entire property is `undefined` for cached responses and responses returned directly by hooks or custom request functions without timing information.

	__Note__: The time is a `number` representing the milliseconds elapsed since the UNIX epoch.
	*/
	timings?: Timings;

	/**
	The number of times the request was retried.
	*/
	retryCount: number;

	// Defined only if request errored
	/**
	The raw result of the request.
	*/
	rawBody?: Uint8Array<ArrayBuffer>;

	/**
	The result of the request.
	*/
	body?: unknown;

	/**
	Whether the response was successful.

	__Note__: Got throws automatically when `response.ok` is `false` and `throwHttpErrors` is `true`.
	*/
	ok: boolean;
} & IncomingMessageWithTimings;

// For Promise support
export type Response<T = unknown> = {
	/**
	The result of the request.
	*/
	body: T;

	/**
	The raw result of the request.
	*/
	rawBody: Uint8Array<ArrayBuffer>;
} & PlainResponse;

export const isResponseOk = (response: PlainResponse): boolean => {
	const {statusCode} = response;
	if ((statusCode >= 200 && statusCode <= 299) || statusCode === 304) {
		return true;
	}

	if (statusCode < 300 || statusCode > 399) {
		return false;
	}

	const {followRedirect} = response.request.options;
	if (typeof followRedirect !== 'function') {
		return !followRedirect;
	}

	let decision = redirectDecisions.get(response);
	if (decision?.predicate !== followRedirect) {
		decision = {predicate: followRedirect, follow: followRedirect(response)};
		redirectDecisions.set(response, decision);
	}

	return !decision.follow;
};

/**
Shares the redirect decision when a response stream is wrapped for decompression.
*/
export const copyRedirectDecision = (source: PlainResponse, destination: PlainResponse): void => {
	const decision = redirectDecisions.get(source);
	if (decision !== undefined) {
		redirectDecisions.set(destination, decision);
	}
};

/**
An error to be thrown when server response code is 2xx, and parsing body fails.
Includes a `response` property.
*/
export class ParseError extends RequestError {
	override name = 'ParseError';
	override code = 'ERR_BODY_PARSE_FAILURE';
	declare readonly response: Response;

	constructor(error: Error, response: Response) {
		const {options} = response.request;
		// The thrown value is kept as the cause, so only its message is normalized.
		super(`${normalizeError(error).message} in "${stripUrlAuth(options.url!)}"`, error, response.request, response);
	}
}

export const cacheDecodedBody = (response: PlainResponse, decodedBody: string): void => {
	decodedBodyCache.set(response, decodedBody);
};

export const parseBody = (response: Response, responseType: ResponseType, parseJson: ParseJsonFunction, encoding?: BufferEncoding): unknown => {
	const {rawBody} = response;
	const cachedDecodedBody = decodedBodyCache.get(response);
	// Shortcuts must read the current bytes because callers can mutate `rawBody`.
	decodedBodyCache.delete(response);

	try {
		if (responseType === 'text') {
			return cachedDecodedBody ?? decodeUint8Array(rawBody, encoding);
		}

		if (responseType === 'json') {
			if (rawBody.length === 0) {
				return '';
			}

			const text = cachedDecodedBody ?? decodeUint8Array(rawBody, encoding);
			return parseJson(text);
		}

		if (responseType === 'buffer') {
			return rawBody;
		}
	} catch (error) {
		// `ParseError` normalizes the message and keeps the thrown value as the cause.
		throw new ParseError(error as Error, response);
	}

	throw new ParseError({
		message: `Unknown body type '${responseType as string}'`,
		name: 'Error',
	}, response);
};
