import process from 'node:process';
import {Buffer} from 'node:buffer';
import {EventEmitter, once} from 'node:events';
import {PassThrough, Readable as ReadableStream} from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import assert from 'node:assert/strict';
import delay from 'delay';
import getStream from 'get-stream';
import type {Handler} from 'express';
import {createSandbox} from 'sinon';
import got, {
	AbortError,
	TimeoutError,
	type Got,
	type OptionsInit,
	type Progress,
} from '../source/index.js';
import Request from '../source/core/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import slowDataStream from './helpers/slow-data-stream.js';
import type {GlobalClock} from './helpers/types.js';
import type {ExtendedHttpTestServer} from './helpers/create-http-test-server.js';
import withServer, {withServerAndFakeTimers} from './helpers/with-server.js';

type LimitProgressRequest = {
	on: (event: 'downloadProgress' | 'uploadProgress', listener: (progress: Progress) => void) => LimitProgressRequest;
	destroy: (error?: Error) => void;
};

const prepareServer = (server: ExtendedHttpTestServer, clock: GlobalClock): {
	emitter: EventEmitter;
	promise: Promise<unknown>;
	redirectRequestCount: () => number;
} => {
	const emitter = new EventEmitter();
	let redirectRequestCount = 0;

	const promise = new Promise<void>((resolve, reject) => {
		server.all('/abort', async (request, response) => {
			emitter.emit('connection');

			request.once('aborted', resolve);
			response.once('finish', reject.bind(null, new Error('Request finished instead of aborting.')));

			try {
				await once(request, 'end');
			} catch {
				// Node.js 15.0.0 throws AND emits `aborted`
			}

			response.end();
		});

		server.get('/redirect', (_request, response) => {
			redirectRequestCount++;
			response.writeHead(302, {
				location: `${server.url}/abort`,
			});
			response.end();

			emitter.emit('sentRedirect');

			clock.tick(3000);
			resolve();
		});
	});

	return {
		emitter,
		promise,
		redirectRequestCount: () => redirectRequestCount,
	};
};

const downloadHandler = (clock?: GlobalClock): Handler => (_request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked',
	});

	response.flushHeaders();

	(async () => {
		try {
			await streamPipeline(
				slowDataStream(clock),
				response,
			);
		} catch {}

		response.end();
	})();
};

const sandbox = createSandbox();

const createAbortController = (): {controller: AbortController; signalHandlersRemoved: () => boolean} => {
	const controller = new AbortController();
	sandbox.spy(controller.signal);
	// @ts-expect-error AbortSignal type definition issue: https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/57805
	const signalHandlersRemoved = () => controller.signal.addEventListener.callCount === controller.signal.removeEventListener.callCount;
	return {
		controller, signalHandlersRemoved,
	};
};

test.afterEach(() => {
	sandbox.restore();
});

test('stops reading buffered response data when destroyed from downloadProgress', async _t => {
	const request = new Request('http://example.com');
	const response = new PassThrough({highWaterMark: 1});
	const transferredEvents: number[] = [];
	const closed = new Promise<void>(resolve => {
		request.once('close', resolve);
	});

	request.on('error', () => {});
	request.response = response as unknown as typeof request.response;
	Object.defineProperty(request, '_responseSize', {
		value: 100,
		writable: true,
	});

	request.on('downloadProgress', progress => {
		transferredEvents.push(progress.transferred);

		if (progress.transferred > 0) {
			request.destroy(new Error('Stop reading'));
		}
	});

	response.write(Buffer.alloc(10));
	response.write(Buffer.alloc(10));
	response.write(Buffer.alloc(10));
	request.resume();

	await closed;

	assert.strictEqual(transferredEvents.length > 0, true);
	assert.strictEqual(transferredEvents.at(-1)! < 30, true, 'destroy should stop reading before all data is consumed');
});

test('supports abort signals added by handlers before next', withServer, async (_t, server, got) => {
	const responseBody = Buffer.alloc(1024 * 1024 * 20);
	const downloadProgressEvents: Progress[] = [];
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': responseBody.length,
		});
		response.end(responseBody);
	});

	const limitDownloadUpload = got.extend({
		handlers: [
			(options, next) => {
				const {downloadLimit, uploadLimit} = options.context;

				let controller: AbortController | undefined;
				let {signal} = options;

				if ((downloadLimit !== undefined || uploadLimit !== undefined) && !signal) {
					controller = new AbortController();
					signal = controller.signal;
					options.signal = signal;
				}

				const promiseOrStream = next(options);
				const limitProgressRequest = promiseOrStream as LimitProgressRequest;

				if (typeof downloadLimit === 'number') {
					limitProgressRequest.on('downloadProgress', progress => {
						downloadProgressEvents.push(progress);

						if (progress.transferred > downloadLimit && progress.percent !== 1) {
							const error = new Error(`Exceeded the download limit of ${downloadLimit} bytes`);

							if (options.isStream) {
								limitProgressRequest.destroy(error);
							} else {
								controller?.abort(error);
							}
						}
					});
				}

				if (typeof uploadLimit === 'number') {
					limitProgressRequest.on('uploadProgress', progress => {
						if (progress.transferred > uploadLimit && progress.percent !== 1) {
							const error = new Error(`Exceeded the upload limit of ${uploadLimit} bytes`);

							if (options.isStream) {
								limitProgressRequest.destroy(error);
							} else {
								controller?.abort(error);
							}
						}
					});
				}

				return promiseOrStream;
			},
		],
	});

	const error = await rejects(limitDownloadUpload('', {
		context: {
			downloadLimit: 10,
		},
	}), {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.ok(error instanceof Error);

	assert.strictEqual(downloadProgressEvents.some(progress => progress.transferred > 10), true);
	assert.strictEqual(downloadProgressEvents.every(progress => progress.percent < 1), true);
	assert.strictEqual(downloadProgressEvents.at(-1)!.transferred < responseBody.length, true);
});

test('supports already aborted signals added by handlers before next', withServer, async (_t, server, got) => {
	let serverRequests = 0;
	server.get('/', (_request, response) => {
		serverRequests++;
		response.end();
	});

	const gotWithAbortedSignal = got.extend({
		handlers: [
			(options, next) => {
				const controller = new AbortController();
				options.signal = controller.signal;
				controller.abort();

				return next(options);
			},
		],
	});

	await assert.rejects(gotWithAbortedSignal(''), {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(serverRequests, 0, 'Request should not reach the server.');
});

test('supports already aborted signals added by beforeRequest hooks', withServer, async (_t, server, got) => {
	let serverRequests = 0;
	server.get('/', (_request, response) => {
		serverRequests++;
		response.end();
	});

	await assert.rejects(got('', {
		hooks: {
			beforeRequest: [
				options => {
					options.signal = AbortSignal.abort();
				},
			],
		},
	}), {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(serverRequests, 0, 'Request should not reach the server.');
});

test.serial('does not attach a replacement abort signal after the request is destroyed', withServer, async (_t, server, got) => {
	let serverRequests = 0;
	server.get('/', (_request, response) => {
		serverRequests++;
		response.end();
	});

	const originalController = new AbortController();
	const {controller: replacementController, signalHandlersRemoved} = createAbortController();
	let resolveHookStarted!: () => void;
	let resolveHook!: () => void;
	const hookStarted = new Promise<void>(resolve => {
		resolveHookStarted = resolve;
	});
	const hook = new Promise<void>(resolve => {
		resolveHook = resolve;
	});
	const request = got('', {
		signal: originalController.signal,
		hooks: {
			beforeRequest: [
				async options => {
					options.signal = replacementController.signal;
					resolveHookStarted();
					await hook;
				},
			],
		},
	});
	const assertion = rejects(request, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	await hookStarted;
	originalController.abort();
	resolveHook();
	await assertion;
	await delay(0);

	assert.strictEqual(signalHandlersRemoved(), true, 'Replacement abort signal event handlers not removed');
	assert.strictEqual(serverRequests, 0, 'Request should not reach the server.');
});

test.serial('does not retry after abort', withServerAndFakeTimers, async (_t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);
	const {controller, signalHandlersRemoved} = createAbortController();

	let calculateDelayCalls = 0;
	const gotPromise = got('redirect', {
		signal: controller.signal,
		retry: {
			calculateDelay() {
				calculateDelayCalls++;
				return 0;
			},
		},
	});

	emitter.once('sentRedirect', () => {
		controller.abort();
	});

	await assert.rejects(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	await assert.doesNotReject(promise, 'Request finished instead of aborting.');

	assert.strictEqual(calculateDelayCalls, 0, 'Makes a new try after abort');
	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test.serial('does not make a retry request after abort when calculateDelay returns a positive value', withServerAndFakeTimers, async (_t, server, got, clock) => {
	const {emitter, promise, redirectRequestCount} = prepareServer(server, clock);
	const {controller, signalHandlersRemoved} = createAbortController();

	const gotPromise = got('redirect', {
		signal: controller.signal,
		retry: {
			calculateDelay: () => 100,
			limit: 1,
		},
	});

	emitter.once('sentRedirect', () => {
		controller.abort();
	});

	await assert.rejects(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	clock.tick(1000);

	await assert.doesNotReject(promise, 'Request finished instead of aborting.');
	assert.strictEqual(redirectRequestCount(), 1);
	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test.serial('abort request timeouts', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	const {controller, signalHandlersRemoved} = createAbortController();

	const gotPromise = got({
		signal: controller.signal,
		timeout: {
			request: 10,
		},
		retry: {
			calculateDelay({computedValue}) {
				process.nextTick(() => {
					controller.abort();
				});

				return computedValue ? 20 : 0;
			},
			limit: 1,
		},
	});

	await assert.rejects(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');

	// Wait for unhandled errors
	await delay(40);
});

test.serial('aborts in-progress request', withServerAndFakeTimers, async (_t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);

	const {controller, signalHandlersRemoved} = createAbortController();

	const body = new ReadableStream({
		read() {},
	});
	body.push('1');

	const gotPromise = got.post('abort', {body, signal: controller.signal});

	// Wait for the connection to be established before canceling
	emitter.once('connection', () => {
		controller.abort();
		body.push(null);
	});

	await assert.rejects(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
	await assert.doesNotReject(promise, 'Request finished instead of aborting.');

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test.serial('aborts in-progress request with timeout', withServerAndFakeTimers, async (_t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);

	const {controller, signalHandlersRemoved} = createAbortController();

	const body = new ReadableStream({
		read() {},
	});
	body.push('1');

	const gotPromise = got.post('abort', {body, timeout: {request: 10_000}, signal: controller.signal});

	// Wait for the connection to be established before canceling
	emitter.once('connection', () => {
		controller.abort();
		body.push(null);
	});

	await assert.rejects(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
	await assert.doesNotReject(promise, 'Request finished instead of aborting.');

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test.serial('abort immediately', withServerAndFakeTimers, async (_t, server, got, clock) => {
	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = new Promise<void>((resolve, reject) => {
		// We won't get an abort or even a connection
		// We assume no request within 1000ms equals a (client side) aborted request
		server.get('/abort', (_request, response) => {
			response.once('finish', reject.bind(globalThis, new Error('Request finished instead of aborting.')));
			response.end();
		});

		clock.tick(1000);
		resolve();
	});

	const gotPromise = got('abort', {signal: controller.signal});
	controller.abort();

	await assert.rejects(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
	await assert.doesNotReject(promise, 'Request finished instead of aborting.');

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('recover from abort using abortable promise attribute', async _t => {
	// Abort before connection started
	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = got('http://example.com', {signal: controller.signal});

	controller.abort();

	await assert.doesNotReject(async () => {
		try {
			await promise;
		} catch (error: unknown) {
			if (controller.signal.aborted) {
				return;
			}

			throw error;
		}
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('recover from abort using error instance', async _t => {
	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = got('http://example.com', {signal: controller.signal});

	controller.abort();

	await assert.doesNotReject(async () => {
		try {
			await promise;
		} catch (error: unknown) {
			if (error instanceof Error && error.message === 'This operation was aborted.') {
				return;
			}

			throw error;
		}
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test.serial('throws on incomplete (aborted) response', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', downloadHandler());

	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = got('', {signal: controller.signal});

	clock.setTimeout(() => {
		controller.abort();
	}, 400);
	clock.tick(400);

	await assert.rejects(promise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test.serial('throws on incomplete (aborted) stream response', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const {controller, signalHandlersRemoved} = createAbortController();

	const stream = got.stream('', {signal: controller.signal});

	clock.setTimeout(() => {
		controller.abort();
	}, 400);
	clock.tick(400);

	await assert.rejects(getStream(stream), {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('throws when aborting cached request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(Date.now().toString());
	});

	const cache = new Map();

	await got({cache});

	const {controller, signalHandlersRemoved} = createAbortController();
	const promise = got({cache, signal: controller.signal});
	controller.abort();

	await assert.rejects(promise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('removes abort signal event handlers after successful request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {controller, signalHandlersRemoved} = createAbortController();
	const response = await got('', {signal: controller.signal});

	assert.strictEqual(response.body, 'ok');
	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('support setting the signal as a default option', async _t => {
	const {controller, signalHandlersRemoved} = createAbortController();

	const got2 = got.extend({signal: controller.signal});
	const p = got2('http://example.com');
	controller.abort();

	await assert.rejects(p, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

const timeoutErrorCode = 'ETIMEDOUT';
// See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
test('support AbortSignal.timeout()', async _t => {
	const signal = AbortSignal.timeout(1);

	const p = got('http://example.com', {signal});

	await assert.rejects(p, {
		name: 'TimeoutError',
		code: timeoutErrorCode,
		message: 'The operation was aborted due to timeout',
	});
});

test.serial('support AbortSignal.timeout() with stream', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const signal = AbortSignal.timeout(1);
	const stream = got.stream('', {signal});

	clock.tick(1);

	await assert.rejects(getStream(stream), {
		name: 'TimeoutError',
		code: timeoutErrorCode,
		message: 'The operation was aborted due to timeout',
	});
});

test.serial('support AbortSignal.timeout() with user abort on stream', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const controller = new AbortController();
	const timeoutSignal = AbortSignal.timeout(1000);
	const signal = AbortSignal.any([
		controller.signal,
		timeoutSignal,
	]);

	const stream = got.stream('', {signal});

	clock.setTimeout(() => {
		controller.abort();
	}, 10);
	clock.tick(10);

	await assert.rejects(getStream(stream), {
		name: 'AbortError',
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
});

test('support AbortSignal.timeout() without user abort', async _t => {
	const {controller, signalHandlersRemoved} = createAbortController();
	const timeoutSignal = AbortSignal.timeout(1);
	const signal = AbortSignal.any([
		controller.signal,
		timeoutSignal,
	]);
	const p = got('http://example.com', {signal});

	await assert.rejects(p, {
		name: 'TimeoutError',
		code: timeoutErrorCode,
		message: 'The operation was aborted due to timeout',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('support AbortSignal.timeout() with user abort', async _t => {
	const {controller, signalHandlersRemoved} = createAbortController();
	const timeoutSignal = AbortSignal.timeout(1000);
	const signal = AbortSignal.any([
		controller.signal,
		timeoutSignal,
	]);

	setTimeout(() => {
		controller.abort();
	}, 10);

	const p = got('http://example.com', {signal});

	await assert.rejects(p, {
		name: 'AbortError',
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
});

test('an already timed-out signal exposes the documented timeout error code', withServer, async (_t, _server, got) => {
	const reason = new DOMException('Deadline reached', 'TimeoutError');
	const signal = AbortSignal.abort(reason);
	const error = await rejects(got('', {signal}), TimeoutError);

	assert.strictEqual(error.code, 'ETIMEDOUT');
	assert.strictEqual(error.cause, reason);
});

for (const streamMode of [false, true]) {
	test(`active timeout signals retain their cause and timeout code in stream mode ${streamMode}`, withServer, async (_t, server, got) => {
		server.get('/', () => {});
		const signal = AbortSignal.timeout(20);
		const result = streamMode ? getStream(got.stream('', {signal})) : got('', {signal});
		const error = await rejects(result, TimeoutError);

		assert.strictEqual(error.code, 'ETIMEDOUT');
		assert.strictEqual(error.cause, signal.reason);
		assert.strictEqual(error.name, 'TimeoutError');
	});
}

test('ordinary AbortSignals retain their supplied cause', withServer, async (_t, _server, got) => {
	const cause = new Error('Cancelled by the caller');
	const error = await rejects(got('', {
		signal: AbortSignal.abort(cause),
	}), AbortError);

	assert.strictEqual(error.cause, cause);
});

const abortReasons = [
	['Error', Object.assign(new Error('Caller cancellation'), {code: 'ECONNRESET'})],
	['string', 'Caller cancellation'],
	['object', {message: 'Caller cancellation', code: 'ECONNRESET'}],
	['null', null],
] as const;

for (const [label, reason] of abortReasons) {
	for (const streamMode of [false, true]) {
		test(`active aborts preserve ${label} reasons in stream mode ${streamMode}`, withServer, async (_t, server, got) => {
			const controller = new AbortController();
			server.get('/', () => {
				controller.abort(reason);
			});

			const options = {signal: controller.signal};
			const result = streamMode ? getStream(got.stream('', options)) : got('', options);
			const error = await rejects(result, errorMatching(AbortError, {code: 'ERR_ABORTED', message: 'This operation was aborted.'}));

			assert.strictEqual(error.cause, reason);
			assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, 'cause'), false);
		});
	}
}

test('abort without an explicit reason retains the default DOMException', withServer, async (_t, _server, got) => {
	const signal = AbortSignal.abort();
	const error = await rejects(got('', {signal}), errorMatching(AbortError, {code: 'ERR_ABORTED'}));

	assert.strictEqual(error.cause, signal.reason);
	assert.strictEqual(error.cause instanceof DOMException, true);
});

test('AbortError without a signal preserves its existing cause and error code', withServer, (_t, server) => {
	const request = new Request(server.url);
	request.destroy();
	const error = new AbortError(request);

	assert.strictEqual(error.message, 'This operation was aborted.');
	assert.strictEqual(error.code, 'ERR_ABORTED');
	assert.deepStrictEqual(error.cause, {});
	assert.strictEqual(error.request, request);
});

// `AbortSignal.timeout()` rejects with a `DOMException`, which names no phase, so the error
// still has to report one.
test('AbortSignal.timeout() produces a TimeoutError with an event', async _t => {
	const error = await rejects(got('http://example.com', {
		signal: AbortSignal.timeout(1),
		retry: {
			limit: 0,
		},
	}));

	assert.strictEqual(error?.name, 'TimeoutError');
	assert.strictEqual(error?.code, 'ETIMEDOUT');
	assert.strictEqual(error?.event, 'request');
});

// The abort listener must survive until the request is done, so a hook can still abort.
test('aborting inside an afterResponse hook rejects the request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('early response');
	});

	const abortController = new AbortController();
	const error = await rejects(got('', {
		signal: abortController.signal,
		retry: {
			limit: 0,
		},
		hooks: {
			afterResponse: [async () => {
				await delay(20);
				abortController.abort();
				return undefined!;
			}],
		},
	}));

	assert.strictEqual(error.name, 'AbortError');
});

type RetryAbortScenario = {
	streamMode: boolean;
	failure: 'reset' | 'status';
};

/**
Makes a request whose first attempt fails, so it waits for a retry, and reports what happened to it.

A Got stream follows the documented retry pattern and consumes the stream from `createRetryStream`.
*/
const startRetriedRequest = (got: Got, server: ExtendedHttpTestServer, {streamMode, failure}: RetryAbortScenario, options: OptionsInit) => {
	const state = {requests: 0, retryEvents: 0};
	server.get('/', (request, response) => {
		state.requests++;
		if (failure === 'reset') {
			request.socket.destroy();
			return;
		}

		response.statusCode = 503;
		response.end();
	});

	if (!streamMode) {
		return {state, result: got('', options)};
	}

	const result = new Promise<void>((resolve, reject) => {
		const run = (stream: ReturnType<typeof got.stream>) => {
			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				state.retryEvents++;
				run(createRetryStream());
			});
			stream.once('error', reject);
			stream.once('end', resolve);
			stream.resume();
		};

		run(got.stream('', options));
	});

	return {state, result};
};

for (const scenario of [
	{streamMode: false, failure: 'status'},
	{streamMode: false, failure: 'reset'},
	{streamMode: true, failure: 'reset'},
] as const) {
	const label = `in stream mode ${scenario.streamMode} after a ${scenario.failure === 'reset' ? 'connection reset' : 'retryable status'}`;

	test(`aborting during the retry delay prevents the retry ${label}`, withServer, async (_t, server, got) => {
		const {controller, signalHandlersRemoved} = createAbortController();
		const {promise: delayStarted, resolve: startDelay} = Promise.withResolvers<void>();
		let beforeRetryCalls = 0;
		const {state, result} = startRetriedRequest(got, server, scenario, {
			signal: controller.signal,
			retry: {
				limit: 1,
				calculateDelay() {
					startDelay();
					return 300;
				},
			},
			hooks: {
				beforeRetry: [
					() => {
						beforeRetryCalls++;
					},
				],
			},
		});

		await delayStarted;
		controller.abort();

		await rejects(result, errorMatching(AbortError, {code: 'ERR_ABORTED'}));
		await delay(500);

		assert.strictEqual(state.requests, 1);
		assert.strictEqual(state.retryEvents, 0);
		assert.strictEqual(beforeRetryCalls, 0);
		assert.strictEqual(signalHandlersRemoved(), true, 'Abort signal event handlers not removed');
	});

	test(`aborting during an async beforeRetry hook prevents the retry ${label}`, withServer, async (_t, server, got) => {
		const controller = new AbortController();
		const {promise: hookStarted, resolve: startHook} = Promise.withResolvers<void>();
		const {promise: hookReleased, resolve: releaseHook} = Promise.withResolvers<void>();
		const {state, result} = startRetriedRequest(got, server, scenario, {
			signal: controller.signal,
			retry: {limit: 1, backoffLimit: 0, noise: 0},
			hooks: {
				beforeRetry: [
					async () => {
						startHook();
						await hookReleased;
					},
				],
			},
		});

		await hookStarted;
		controller.abort();
		releaseHook();

		await rejects(result, errorMatching(AbortError, {code: 'ERR_ABORTED'}));
		await delay(100);

		assert.strictEqual(state.requests, 1);
		assert.strictEqual(state.retryEvents, 0);
	});
}

// A Got stream disposes its abort listener when a response body ends, even when that response is an HTTP error waiting for a retry. The abort is then ignored until the delay is over, and only the retry stream fails.
test.failing('aborting during the retry delay of a Got stream prevents the retry after a retryable status', withServer, async (_t, server, got) => {
	const controller = new AbortController();
	const {promise: delayStarted, resolve: startDelay} = Promise.withResolvers<void>();
	const {state, result} = startRetriedRequest(got, server, {streamMode: true, failure: 'status'}, {
		signal: controller.signal,
		retry: {
			limit: 1,
			calculateDelay() {
				startDelay();
				return 300;
			},
		},
	});

	await delayStarted;
	controller.abort();

	await rejects(result, errorMatching(AbortError, {code: 'ERR_ABORTED'}));
	assert.strictEqual(state.retryEvents, 0);
});

test('the signal still aborts a retried attempt', withServer, async (_t, server, got) => {
	const controller = new AbortController();
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		if (requests === 1) {
			response.statusCode = 503;
			response.end();
			return;
		}

		controller.abort();
	});

	const error = await rejects(got('', {
		signal: controller.signal,
		retry: {limit: 3, backoffLimit: 0, noise: 0},
	}), errorMatching(AbortError, {code: 'ERR_ABORTED'}));
	await delay(100);

	assert.strictEqual(error.request?.retryCount, 1);
	assert.strictEqual(requests, 2);
});
