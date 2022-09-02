import process from 'process';
import {EventEmitter} from 'events';
import stream, {Readable as ReadableStream} from 'stream';
import test from 'ava';
import delay from 'delay';
import {pEvent} from 'p-event';
import type {Handler} from 'express';
import got from '../source/index.js';
import slowDataStream from './helpers/slow-data-stream.js';
import type {GlobalClock} from './helpers/types.js';
import type {ExtendedHttpTestServer} from './helpers/create-http-test-server.js';
import withServer, {withServerAndFakeTimers} from './helpers/with-server.js';

// eslint-disable-next-line no-negated-condition
if (globalThis.AbortController !== undefined) {
	const prepareServer = (server: ExtendedHttpTestServer, clock: GlobalClock): {emitter: EventEmitter; promise: Promise<unknown>} => {
		const emitter = new EventEmitter();

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
				response.writeHead(302, {
					location: `${server.url}/abort`,
				});
				response.end();

				emitter.emit('sentRedirect');

				clock.tick(3000);
				resolve();
			});
		});

		return {emitter, promise};
	};

	const downloadHandler = (clock?: GlobalClock): Handler => (_request, response) => {
		response.writeHead(200, {
			'transfer-encoding': 'chunked',
		});

		response.flushHeaders();

		stream.pipeline(
			slowDataStream(clock),
			response,
			() => {
				response.end();
			},
		);
	};

	test.serial('does not retry after abort', withServerAndFakeTimers, async (t, server, got, clock) => {
		const {emitter, promise} = prepareServer(server, clock);
		const controller = new AbortController();

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
	});

	test.serial('abort request timeouts', withServer, async (t, server, got) => {
		server.get('/', () => {});

		const controller = new AbortController();

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

		// Wait for unhandled errors
		await delay(40);
	});

	test.serial('aborts in-progress request', withServerAndFakeTimers, async (t, server, got, clock) => {
		const {emitter, promise} = prepareServer(server, clock);

		const controller = new AbortController();

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
	});

	test.serial('aborts in-progress request with timeout', withServerAndFakeTimers, async (t, server, got, clock) => {
		const {emitter, promise} = prepareServer(server, clock);

		const controller = new AbortController();

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
	});

	test.serial('abort immediately', withServerAndFakeTimers, async (t, server, got, clock) => {
		const controller = new AbortController();

		const promise = new Promise<void>((resolve, reject) => {
			// We won't get an abort or even a connection
			// We assume no request within 1000ms equals a (client side) aborted request
			server.get('/abort', (_request, response) => {
				response.once('finish', reject.bind(global, new Error('Request finished instead of aborting.')));
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
	});

	test('recover from abort using abortable promise attribute', async t => {
		// Abort before connection started
		const controller = new AbortController();

		const p = got('http://example.com', {signal: controller.signal});
		const recover = p.catch((error: Error) => {
			if (controller.signal.aborted) {
				return;
			}

			throw error;
		});

		controller.abort();

		await t.notThrowsAsync(recover);
	});

	test('recover from abort using error instance', async t => {
		const controller = new AbortController();

		const p = got('http://example.com', {signal: controller.signal});
		const recover = p.catch((error: Error) => {
			if (error.message === 'This operation was aborted.') {
				return;
			}

			throw error;
		});

		controller.abort();

		await t.notThrowsAsync(recover);
	});

	// TODO: Use `fakeTimers` here
	test.serial('throws on incomplete (aborted) response', withServer, async (t, server, got) => {
		server.get('/', downloadHandler());

		const controller = new AbortController();

		const promise = got('', {signal: controller.signal});

		setTimeout(() => {
			controller.abort();
		}, 400);

		await t.throwsAsync(promise, {
			code: 'ERR_ABORTED',
			message: 'This operation was aborted.',
		});
	});

	test('throws when aborting cached request', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.end(Date.now().toString());
		});

		const cache = new Map();

		await got({cache});

		const controller = new AbortController();
		const promise = got({cache, signal: controller.signal});
		controller.abort();

		await t.throwsAsync(promise, {
			code: 'ERR_ABORTED',
			message: 'This operation was aborted.',
		});
	});

	test('support setting the signal as a default option', async t => {
		const controller = new AbortController();

		const got2 = got.extend({signal: controller.signal});
		const p = got2('http://example.com', {signal: controller.signal});
		controller.abort();

		await t.throwsAsync(p, {
			code: 'ERR_ABORTED',
			message: 'This operation was aborted.',
		});
	});
} else {
	test('x', t => {
		t.pass();
	});
}
