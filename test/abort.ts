import process from 'node:process';
import {Buffer} from 'node:buffer';
import {EventEmitter} from 'node:events';
import {PassThrough, Readable as ReadableStream} from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import test from 'ava';
import delay from 'delay';
import getStream from 'get-stream';
import {pEvent} from 'p-event';
import type {Handler} from 'express';
import {createSandbox} from 'sinon';
import got, {type Progress} from '../source/index.js';
import Request from '../source/core/index.js';
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
				await pEvent(request, 'end');
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

test('stops reading buffered response data when destroyed from downloadProgress', async t => {
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

	t.deepEqual(transferredEvents, [20]);
});

test('supports abort signals added by handlers before next', withServer, async (t, server, got) => {
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

	try {
		await limitDownloadUpload('', {
			context: {
				downloadLimit: 10,
			},
		});
		t.fail('Request resolved instead of aborting.');
	} catch (error: unknown) {
		t.like(error, {
			code: 'ERR_ABORTED',
			message: 'This operation was aborted.',
		});
	}

	t.true(downloadProgressEvents.some(progress => progress.transferred > 10));
	t.true(downloadProgressEvents.every(progress => progress.percent < 1));
	t.true(downloadProgressEvents.at(-1)!.transferred < responseBody.length);
});

test('supports already aborted signals added by handlers before next', withServer, async (t, server, got) => {
	server.get('/', () => {
		t.fail('Request should not reach the server.');
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

	await t.throwsAsync(gotWithAbortedSignal(''), {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
});

test.serial('does not retry after abort', withServerAndFakeTimers, async (t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);
	const {controller, signalHandlersRemoved} = createAbortController();

	const gotPromise = got('redirect', {
		signal: controller.signal,
		retry: {
			calculateDelay() {
				t.fail('Makes a new try after abort');
				return 0;
			},
		},
	});

	emitter.once('sentRedirect', () => {
		controller.abort();
	});

	await t.throwsAsync(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test.serial('does not make a retry request after abort when calculateDelay returns a positive value', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	await t.throwsAsync(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	clock.tick(1000);

	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
	t.is(redirectRequestCount(), 1);
	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test.serial('abort request timeouts', withServer, async (t, server, got) => {
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

				if (computedValue) {
					return 20;
				}

				return 0;
			},
			limit: 1,
		},
	});

	await t.throwsAsync(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');

	// Wait for unhandled errors
	await delay(40);
});

test.serial('aborts in-progress request', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	await t.throwsAsync(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test.serial('aborts in-progress request with timeout', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	await t.throwsAsync(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test.serial('abort immediately', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	await t.throwsAsync(gotPromise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test('recover from abort using abortable promise attribute', async t => {
	// Abort before connection started
	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = got('http://example.com', {signal: controller.signal});

	controller.abort();

	await t.notThrowsAsync(async () => {
		try {
			await promise;
		} catch (error: unknown) {
			if (controller.signal.aborted) {
				return;
			}

			throw error;
		}
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test('recover from abort using error instance', async t => {
	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = got('http://example.com', {signal: controller.signal});

	controller.abort();

	await t.notThrowsAsync(async () => {
		try {
			await promise;
		} catch (error: unknown) {
			if (error instanceof Error && error.message === 'This operation was aborted.') {
				return;
			}

			throw error;
		}
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test.serial('throws on incomplete (aborted) response', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', downloadHandler());

	const {controller, signalHandlersRemoved} = createAbortController();

	const promise = got('', {signal: controller.signal});

	clock.setTimeout(() => {
		controller.abort();
	}, 400);
	clock.tick(400);

	await t.throwsAsync(promise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test.serial('throws on incomplete (aborted) stream response', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const {controller, signalHandlersRemoved} = createAbortController();

	const stream = got.stream('', {signal: controller.signal});

	clock.setTimeout(() => {
		controller.abort();
	}, 400);
	clock.tick(400);

	await t.throwsAsync(getStream(stream), {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test('throws when aborting cached request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(Date.now().toString());
	});

	const cache = new Map();

	await got({cache});

	const {controller, signalHandlersRemoved} = createAbortController();
	const promise = got({cache, signal: controller.signal});
	controller.abort();

	await t.throwsAsync(promise, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test('removes abort signal event handlers after successful request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {controller, signalHandlersRemoved} = createAbortController();
	const response = await got('', {signal: controller.signal});

	t.is(response.body, 'ok');
	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test('support setting the signal as a default option', async t => {
	const {controller, signalHandlersRemoved} = createAbortController();

	const got2 = got.extend({signal: controller.signal});
	const p = got2('http://example.com');
	controller.abort();

	await t.throwsAsync(p, {
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

const timeoutErrorCode = 23;
// See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
test('support AbortSignal.timeout()', async t => {
	const signal = AbortSignal.timeout(1);

	const p = got('http://example.com', {signal});

	await t.throwsAsync(p, {
		name: 'TimeoutError',
		code: timeoutErrorCode,
		message: 'The operation was aborted due to timeout',
	});
});

test.serial('support AbortSignal.timeout() with stream', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const signal = AbortSignal.timeout(1);
	const stream = got.stream('', {signal});

	clock.tick(1);

	await t.throwsAsync(getStream(stream), {
		name: 'TimeoutError',
		code: timeoutErrorCode,
		message: 'The operation was aborted due to timeout',
	});
});

test.serial('support AbortSignal.timeout() with user abort on stream', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	await t.throwsAsync(getStream(stream), {
		name: 'AbortError',
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});
});

test('support AbortSignal.timeout() without user abort', async t => {
	const {controller, signalHandlersRemoved} = createAbortController();
	const timeoutSignal = AbortSignal.timeout(1);
	const signal = AbortSignal.any([
		controller.signal,
		timeoutSignal,
	]);
	const p = got('http://example.com', {signal});

	await t.throwsAsync(p, {
		name: 'TimeoutError',
		code: timeoutErrorCode,
		message: 'The operation was aborted due to timeout',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});

test('support AbortSignal.timeout() with user abort', async t => {
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

	await t.throwsAsync(p, {
		name: 'AbortError',
		code: 'ERR_ABORTED',
		message: 'This operation was aborted.',
	});

	t.true(signalHandlersRemoved(), 'Abort signal event handlers not removed');
});
