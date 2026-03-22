import {randomUUID} from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import type {Timings} from './utils/timer.js';
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

const publishToChannel = (channel: diagnosticsChannel.Channel, message: unknown): void => {
	if (channel.hasSubscribers) {
		channel.publish(message);
	}
};

export function publishRequestCreate(message: DiagnosticRequestCreate): void {
	publishToChannel(channels.requestCreate, message);
}

export function publishRequestStart(message: DiagnosticRequestStart): void {
	publishToChannel(channels.requestStart, message);
}

export function publishResponseStart(message: DiagnosticResponseStart): void {
	publishToChannel(channels.responseStart, message);
}

export function publishResponseEnd(message: DiagnosticResponseEnd): void {
	publishToChannel(channels.responseEnd, message);
}

export function publishRetry(message: DiagnosticRequestRetry): void {
	publishToChannel(channels.retry, message);
}

export function publishError(message: DiagnosticRequestError): void {
	publishToChannel(channels.error, message);
}

export function publishRedirect(message: DiagnosticResponseRedirect): void {
	publishToChannel(channels.redirect, message);
}
