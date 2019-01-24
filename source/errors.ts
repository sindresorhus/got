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
	code: number | undefined;

	body: string | undefined;

	statusCode: number | undefined;

	statusMessage: string | undefined;

	headers: string | undefined;

	redirectUrls: string | undefined;

	event: string | undefined;

	timings: number | undefined;

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

export const CacheError = class extends GotError {
	constructor(error: any, options: Options) {
		super(error.message, error, options);
		this.name = 'CacheError';
	}
};

export const RequestError = class extends GotError {
	constructor(error: any, options: Options) {
		super(error.message, error, options);
		this.name = 'RequestError';
	}
};

exports.ReadError = class extends GotError {
	constructor(error: any, options: Options) {
		super(error.message, error, options);
		this.name = 'ReadError';
	}
};

exports.ParseError = class extends GotError {
	constructor(error: any, statusCode: number, options: Options, data: any) {
		super(`${error.message} in "${urlLib.format(options)}"`, error, options);
		this.name = 'ParseError';
		this.body = data;
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
	}
};

exports.HTTPError = class extends GotError {
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
};

exports.MaxRedirectsError = class extends GotError {
	constructor(statusCode: number, redirectUrls: string, options: Options) {
		super('Redirected 10 times. Aborting.', {}, options);
		this.name = 'MaxRedirectsError';
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
		this.redirectUrls = redirectUrls;
	}
};

exports.UnsupportedProtocolError = class extends GotError {
	constructor(options: Options) {
		super(`Unsupported protocol "${options.protocol}"`, {}, options);
		this.name = 'UnsupportedProtocolError';
	}
};

exports.TimeoutError = class extends GotError {
	constructor(error: any, timings: number, options: Options) {
		super(error.message, {code: 'ETIMEDOUT'}, options);
		this.name = 'TimeoutError';
		this.event = error.event;
		this.timings = timings;
	}
};

exports.CancelError = PCancelable.CancelError;
