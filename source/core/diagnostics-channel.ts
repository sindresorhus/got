import {randomUUID} from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import type {Timings} from '@szmarczak/http-timer';
import type {RequestError} from './errors.js';

const channels = {
	requestCreate: diagnosticsChannel.channel('got:request:create'),
	requestStart: diagnosticsChannel.channel('got:request:start'),
	responseStart: diagnosticsChannel.channel('got:response:start'),
	responseEnd: diagnosticsChannel.channel('got:response:end'),
	retry: diagnosticsChannel.channel('got:request:retry'),
	error: diagnosticsChannel.channel('got:request:error'),
	redirect: diagnosticsChannel.channel('got:response:redirect'),
};

export type RequestId = string;

/**
Message for the `got:request:create` diagnostic channel.

Emitted when a request is created.
*/
export type DiagnosticRequestCreate = {
	requestId: RequestId;
	url: string;
	method: string;
};

/**
Message for the `got:request:start` diagnostic channel.

Emitted before the native HTTP request is sent.
*/
export type DiagnosticRequestStart = {
	requestId: RequestId;
	url: string;
	method: string;
	headers: Record<string, string | string[] | undefined>;
};

/**
Message for the `got:response:start` diagnostic channel.

Emitted when response headers are received.
*/
export type DiagnosticResponseStart = {
	requestId: RequestId;
	url: string;
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	isFromCache: boolean;
};

/**
Message for the `got:response:end` diagnostic channel.

Emitted when the response completes.
*/
export type DiagnosticResponseEnd = {
	requestId: RequestId;
	url: string;
	statusCode: number;
	bodySize?: number;
	timings?: Timings;
};

/**
Message for the `got:request:retry` diagnostic channel.

Emitted when retrying a request.
*/
export type DiagnosticRequestRetry = {
	requestId: RequestId;
	retryCount: number;
	error: RequestError;
	delay: number;
};

/**
Message for the `got:request:error` diagnostic channel.

Emitted when a request fails.
*/
export type DiagnosticRequestError = {
	requestId: RequestId;
	url: string;
	error: RequestError;
	timings?: Timings;
};

/**
Message for the `got:response:redirect` diagnostic channel.

Emitted when following a redirect.
*/
export type DiagnosticResponseRedirect = {
	requestId: RequestId;
	fromUrl: string;
	toUrl: string;
	statusCode: number;
};

export function generateRequestId(): RequestId {
	return randomUUID();
}

export function publishRequestCreate(message: DiagnosticRequestCreate): void {
	if (channels.requestCreate.hasSubscribers) {
		channels.requestCreate.publish(message);
	}
}

export function publishRequestStart(message: DiagnosticRequestStart): void {
	if (channels.requestStart.hasSubscribers) {
		channels.requestStart.publish(message);
	}
}

export function publishResponseStart(message: DiagnosticResponseStart): void {
	if (channels.responseStart.hasSubscribers) {
		channels.responseStart.publish(message);
	}
}

export function publishResponseEnd(message: DiagnosticResponseEnd): void {
	if (channels.responseEnd.hasSubscribers) {
		channels.responseEnd.publish(message);
	}
}

export function publishRetry(message: DiagnosticRequestRetry): void {
	if (channels.retry.hasSubscribers) {
		channels.retry.publish(message);
	}
}

export function publishError(message: DiagnosticRequestError): void {
	if (channels.error.hasSubscribers) {
		channels.error.publish(message);
	}
}

export function publishRedirect(message: DiagnosticResponseRedirect): void {
	if (channels.redirect.hasSubscribers) {
		channels.redirect.publish(message);
	}
}
