import {EventEmitter} from 'events';
import {Readable as ReadableStream} from 'stream';
import stream = require('stream');
import test from 'ava';
import delay = require('delay');
import pEvent = require('p-event');
import getStream = require('get-stream');
import {Handler} from 'express';
import got, {CancelError} from '../source';
import slowDataStream from './helpers/slow-data-stream';
import {GlobalClock} from './helpers/types';
import {ExtendedHttpTestServer} from './helpers/create-http-test-server';
import withServer, {withServerAndFakeTimers} from './helpers/with-server';

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
				location: `${server.url}/abort`
			});
			response.end();

			emitter.emit('sentRedirect');

			clock.tick(3000);
			resolve();
		});
	});

	return {emitter, promise};
};

const downloadHandler = (clock: GlobalClock): Handler => (_request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked'
	});

	response.flushHeaders();

	stream.pipeline(
		slowDataStream(clock),
		response,
		() => {
			response.end();
		}
	);
};

test.serial('does not retry after cancelation', withServerAndFakeTimers, async (t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);

	const gotPromise = got('redirect', {
		retry: {
			calculateDelay: () => {
				t.fail('Makes a new try after cancelation');
				return 0;
			}
		}
	});

	emitter.once('sentRedirect', () => {
		gotPromise.cancel();
	});

	await t.throwsAsync(gotPromise, {instanceOf: CancelError});
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test.serial('cleans up request timeouts', withServer, async (t, server, got) => {
	server.get('/', () => {});

	const gotPromise = got({
		timeout: 10,
		retry: {
			calculateDelay: ({computedValue}) => {
				process.nextTick(() => gotPromise.cancel());

				if (computedValue) {
					return 20;
				}

				return 0;
			},
			limit: 1
		}
	});

	await t.throwsAsync(gotPromise, {instanceOf: CancelError});

	// Wait for unhandled errors
	await delay(40);
});

test.serial('cancels in-progress request', withServerAndFakeTimers, async (t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);

	const body = new ReadableStream({
		read() {}
	});
	body.push('1');

	const gotPromise = got.post('abort', {body});

	// Wait for the connection to be established before canceling
	emitter.once('connection', () => {
		gotPromise.cancel();
		body.push(null);
	});

	await t.throwsAsync(gotPromise, {instanceOf: CancelError});
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test.serial('cancels in-progress request with timeout', withServerAndFakeTimers, async (t, server, got, clock) => {
	const {emitter, promise} = prepareServer(server, clock);

	const body = new ReadableStream({
		read() {}
	});
	body.push('1');

	const gotPromise = got.post('abort', {body, timeout: 10000});

	// Wait for the connection to be established before canceling
	emitter.once('connection', () => {
		gotPromise.cancel();
		body.push(null);
	});

	await t.throwsAsync(gotPromise, {instanceOf: CancelError});
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test.serial('cancel immediately', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	const gotPromise = got('abort');
	gotPromise.cancel();

	await t.throwsAsync(gotPromise);
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test('recover from cancelation using cancelable promise attribute', async t => {
	// Canceled before connection started
	const p = got('http://example.com');
	const recover = p.catch((error: Error) => {
		if (p.isCanceled) {
			return;
		}

		throw error;
	});

	p.cancel();

	await t.notThrowsAsync(recover);
});

test('recover from cancellation using error instance', async t => {
	// Canceled before connection started
	const p = got('http://example.com');
	const recover = p.catch((error: Error) => {
		if (error instanceof got.CancelError) {
			return;
		}

		throw error;
	});

	p.cancel();

	await t.notThrowsAsync(recover);
});

test.serial('throws on incomplete (canceled) response - promise', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {request: 500},
			retry: 0
		}),
		{instanceOf: got.TimeoutError}
	);
});

test.serial('throws on incomplete (canceled) response - promise #2', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const promise = got('').on('response', () => {
		clock.tick(500);
		promise.cancel();
	});

	await t.throwsAsync(promise, {instanceOf: got.CancelError});
});

test.serial('throws on incomplete (canceled) response - stream', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	const errorString = 'Foobar';

	const stream = got.stream('').on('response', () => {
		clock.tick(500);
		stream.destroy(new Error(errorString));
	});

	await t.throwsAsync(getStream(stream), {message: errorString});
});

// Note: it will throw, but the response is loaded already.
test('throws when canceling cached request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(Date.now().toString());
	});

	const cache = new Map();
	await got({cache});

	const promise = got({cache}).on('response', () => {
		promise.cancel();
	});

	await t.throwsAsync(promise, {instanceOf: got.CancelError});
});

test('throws when canceling cached request #2', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(Date.now().toString());
	});

	const cache = new Map();
	await got({cache});

	const promise = got({cache});
	promise.cancel();

	await t.throwsAsync(promise, {instanceOf: got.CancelError});
});
