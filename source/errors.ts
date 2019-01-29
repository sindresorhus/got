import urlLib from 'url';
import http from 'http';
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

export class GotError extends Error {
	code?: number;

	body?: string;

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
	constructor(error: any, options: Options) {
		super(error.message, error, options);
		this.name = 'CacheError';
	}
}

export class RequestError extends GotError {
	constructor(error: any, options: Options) {
		super(error.message, error, options);
		this.name = 'RequestError';
	}
}

export class ReadError extends GotError {
	constructor(error: any, options: Options) {
		super(error.message, error, options);
		this.name = 'ReadError';
	}
}

export class ParseError extends GotError {
	statusCode: number;

	constructor(error: any, statusCode: number, options: any, data: any) {
		super(`${error.message} in "${urlLib.format(options)}"`, error, options);
		this.name = 'ParseError';
		this.body = data;
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
	}
}

export class HTTPError extends GotError {
	headers?: string;

	constructor(response: any, options: Options) {
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
	redirectUrls?: string;

	constructor(statusCode: number, redirectUrls: string, options: Options) {
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
	timings: number;

	event: string;

	constructor(error: any, timings: number, options: Options) {
		super(error.message, {code: 'ETIMEDOUT'}, options);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
}

exports.CancelError = PCancelable.CancelError;
