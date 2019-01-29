import urlLib from 'url';
import http, {IncomingMessage, IncomingHttpHeaders} from 'http';
import PCancelable from 'p-cancelable';
import is from '@sindresorhus/is';

// TODO: Use the Got options-object type
interface Options {
	host: string;
	hostname: string;
	method: string;
	path: string;
	socketPath: string;
	protocol: string;
	href: string;
	options: string;
}

interface IncomingMessageExtended extends IncomingMessage {
	body: string;
	statusCode: number;
}

interface Timings {
	start: number;
	socket: number;
	lookup: number;
	connect: number;
	upload: number;
	response: number;
	end: number;
	error: number;
	phases: {
		wait: number;
		dns: number;
		tcp: number;
		request: number;
		firstByte: number;
		download: number;
		total: number;
	};
}

export class GotError extends Error {
	code?: number;

	statusMessage?: string;

	statusCode?: number;

	constructor(message: string, error: any, options: Options) {
		super(message);
		Error.captureStackTrace(this, this.constructor);
		this.name = 'GotError';

		if (!is.undefined(error.code)) {
			this.code = error.code;
		}

		Object.assign(this, {
			host: options.host,
			hostname: options.hostname,
			method: options.method,
			path: options.path,
			socketPath: options.socketPath,
			protocol: options.protocol,
			url: options.href,
			gotOptions: options.options
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
	statusCode: number;

	body: string | Buffer;

	constructor(error: Error, statusCode: number, options: Options, data: string | Buffer) {
		super(`${error.message} in "${urlLib.format(options)}"`, error, options);
		this.name = 'ParseError';
		this.body = data;
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
	}
}

export class HTTPError extends GotError {
	headers?: IncomingHttpHeaders;

	body: string | undefined;

	constructor(response: IncomingMessageExtended, options: Options) {
		const {statusCode} = response;
		let {statusMessage} = response;

		if (statusMessage) {
			statusMessage = statusMessage.replace(/\r?\n/g, ' ').trim();
		} else {
			statusMessage = http.STATUS_CODES[statusCode];
		}

		super(`Response code ${statusCode} (${statusMessage})`, {}, options);
		this.name = 'HTTPError';
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.headers = response.headers;
		this.body = response.body;
	}
}

export class MaxRedirectsError extends GotError {
	redirectUrls?: URL[];

	constructor(statusCode: number, redirectUrls: URL[], options: Options) {
		super('Redirected 10 times. Aborting.', {}, options);
		this.name = 'MaxRedirectsError';
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
		this.redirectUrls = redirectUrls;
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

	constructor(error: any, timings: Timings, options: Options) {
		super(error.message, {code: 'ETIMEDOUT'}, options);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

exports.CancelError = PCancelable.CancelError;
