import process from 'node:process';
import {EventEmitter} from 'node:events';
import {PassThrough as PassThroughStream} from 'node:stream';
import type {Socket} from 'node:net';
import http from 'node:http';
import test from 'ava';
import is from '@sindresorhus/is';
import type {Handler} from 'express';
import getStream from 'get-stream';
import {pEvent} from 'p-event';
import got, {HTTPError, TimeoutError} from '../source/index.js';
import type Request from '../source/core/index.js';
import withServer from './helpers/with-server.js';

const retryAfterOn413 = 2;
const socketTimeout = 300;

const handler413: Handler = (_request, response) => {
	response.writeHead(413, {
		'Retry-After': retryAfterOn413,
	});
	response.end();
};

const createSocketTimeoutStream = (): http.ClientRequest => {
	const stream = new PassThroughStream();
	// @ts-expect-error Mocking the behaviour of a ClientRequest
	stream.setTimeout = (ms, callback) => {
		process.nextTick(callback);
	};

	// @ts-expect-error Mocking the behaviour of a ClientRequest
	stream.abort = () => {};
	stream.resume();

	return stream as unknown as http.ClientRequest;
};

test('works on timeout', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		response.end('who`s there?');
	});

	t.is((await got({
		timeout: {
			socket: socketTimeout,
		},
		request(...args: [
			string | URL | http.RequestOptions,
			(http.RequestOptions | ((response: http.IncomingMessage) => void))?,
			((response: http.IncomingMessage) => void)?,
		]) {
			if (knocks === 1) {
				// @ts-expect-error Overload error
				return http.request(...args);
			}

			knocks++;
			return createSocketTimeoutStream();
		},
	})).body, 'who`s there?');
});

test('retry function gets iteration count', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
			return;
		}

		response.statusCode = 500;
		response.end();
	});

	await got({
		retry: {
			calculateDelay({attemptCount}) {
				t.true(is.number(attemptCount));
				return attemptCount < 2 ? 1 : 0;
			},
		},
	});
});

test('setting to `0` disables retrying', async t => {
	await t.throwsAsync(got('https://example.com', {
		timeout: {socket: socketTimeout},
		retry: {
			calculateDelay({attemptCount}) {
				t.is(attemptCount, 1);
				return 0;
			},
		},
		request: () => createSocketTimeoutStream(),
	}), {
		instanceOf: TimeoutError,
		message: `Timeout awaiting 'socket' for ${socketTimeout}ms`,
	});
});

test('custom retries', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let hasTried = false;
	const error = await t.throwsAsync<HTTPError>(got({
		throwHttpErrors: true,
		retry: {
			calculateDelay({attemptCount}) {
				if (attemptCount === 1) {
					hasTried = true;
					return 1;
				}

				return 0;
			},
			methods: [
				'GET',
			],
			statusCodes: [
				500,
			],
		},
	}));
	t.is(error?.response.statusCode, 500);
	t.true(hasTried);
});

test('custom retries async', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let hasTried = false;
	const error = await t.throwsAsync<HTTPError>(got({
		throwHttpErrors: true,
		retry: {
			async calculateDelay({attemptCount}) {
				await new Promise(resolve => {
					setTimeout(resolve, 1000);
				});

				if (attemptCount === 1) {
					hasTried = true;
					return 1;
				}

				return 0;
			},
			methods: [
				'GET',
			],
			statusCodes: [
				500,
			],
		},
	}));
	t.is(error?.response.statusCode, 500);
	t.true(hasTried);
});

test('custom error codes', async t => {
	const errorCode = 'OH_SNAP';

	const error = await t.throwsAsync<Error & {code: typeof errorCode}>(got('https://example.com', {
		request() {
			const emitter = new EventEmitter() as http.ClientRequest;
			emitter.abort = () => {};
			// @ts-expect-error Imitating a stream
			emitter.end = () => {};
			// @ts-expect-error Imitating a stream
			emitter.destroy = () => {};
			// @ts-expect-error Imitating a stream
			emitter.writable = true;
			// @ts-expect-error Imitating a stream
			emitter.writableEnded = false;

			const error = new Error('Snap!');
			(error as Error & {code: typeof errorCode}).code = errorCode;
			setTimeout(() => {
				emitter.emit('error', error);
			});

			return emitter;
		},
		retry: {
			calculateDelay({error}) {
				t.is(error.code, errorCode);
				return 0;
			},
			methods: [
				'GET',
			],
			errorCodes: [
				errorCode,
			],
		},
	}));

	t.is(error?.code, errorCode);
});

test('respects 413 Retry-After', withServer, async (t, server, got) => {
	let lastTried413access = Date.now();
	server.get('/', (_request, response) => {
		response.writeHead(413, {
			'Retry-After': retryAfterOn413,
		});
		response.end((Date.now() - lastTried413access).toString());

		lastTried413access = Date.now();
	});

	const {statusCode, body} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
		},
	});
	t.is(statusCode, 413);
	t.true(Number(body) >= retryAfterOn413 * 1000);
});

test('respects 413 Retry-After with RFC-1123 timestamp', withServer, async (t, server, got) => {
	let lastTried413TimestampAccess: string;
	server.get('/', (_request, response) => {
		const date = (new Date(Date.now() + (retryAfterOn413 * 1000))).toUTCString();

		response.writeHead(413, {
			'Retry-After': date,
		});
		response.end(lastTried413TimestampAccess);
		lastTried413TimestampAccess = date;
	});

	const {statusCode, body} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
		},
	});
	t.is(statusCode, 413);
	t.true(Date.now() >= Date.parse(body));
});

test('doesn\'t retry on 413 with empty statusCodes and methods', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			statusCodes: [],
			methods: [],
		},
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('doesn\'t retry on 413 with empty methods', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			statusCodes: [413],
			methods: [],
		},
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('doesn\'t retry on 413 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 413;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false,
	});
	t.is(retryCount, 0);
});

test('retries on 503 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
		},
	});
	t.is(retryCount, 1);
});

test('doesn\'t retry on streams', withServer, async (t, server, got) => {
	server.get('/', () => {});

	// @ts-expect-error Error tests
	const stream = got.stream({
		timeout: {
			request: 1,
		},
		retry: {
			calculateDelay() {
				t.fail('Retries on streams');
			},
		},
	});
	await t.throwsAsync(pEvent(stream, 'response'));
});

test('doesn\'t retry if Retry-After header is greater than maxRetryAfter', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {retryCount} = await got({
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false,
	});
	t.is(retryCount, 0);
});

test('doesn\'t retry when set to 0', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 0,
		},
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('works when defaults.options.retry is a number', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const instance = got.extend({
		retry: {
			limit: 2,
		},
	});

	const {retryCount} = await instance({
		throwHttpErrors: false,
	});
	t.is(retryCount, 2);
});

test('retry function can throw', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const error = 'Simple error';
	await t.throwsAsync(got({
		retry: {
			calculateDelay() {
				throw new Error(error);
			},
		},
	}), {message: error});
});

test('does not retry on POST', withServer, async (t, server, got) => {
	server.post('/', () => {});

	await t.throwsAsync(got.post({
		timeout: {
			request: 200,
		},
		hooks: {
			beforeRetry: [
				() => {
					t.fail('Retries on POST requests');
				},
			],
		},
	}), {instanceOf: TimeoutError});
});

test('does not break on redirect', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let tries = 0;
	server.get('/redirect', (_request, response) => {
		tries++;

		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	await t.throwsAsync(got('redirect'), {message: 'Response code 500 (Internal Server Error)'});
	t.is(tries, 1);
});

test('does not destroy the socket on HTTP error', withServer, async (t, server, got) => {
	let returnServerError = true;

	server.get('/', (_request, response) => {
		if (returnServerError) {
			response.statusCode = 500;
			returnServerError = false;
		}

		response.end();
	});

	const sockets: Socket[] = [];

	const agent = new http.Agent({
		keepAlive: true,
	});

	await got('', {
		agent: {
			http: agent,
		},
	}).on('request', request => {
		sockets.push(request.socket!);
	});

	t.is(sockets.length, 2);
	t.is(sockets[0], sockets[1]);

	agent.destroy();
});

test('can retry a Got stream', withServer, async (t, server, got) => {
	let returnServerError = true;

	server.get('/', (_request, response) => {
		if (returnServerError) {
			response.statusCode = 500;
			response.end('not ok');

			returnServerError = false;
			return;
		}

		response.end('ok');
	});

	let globalRetryCount = 0;

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const fn = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream('');

			globalRetryCount = stream.retryCount;

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();

			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				fn(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				resolve(writeStream);
			});
		};

		fn();
	});

	const responseStream = await responseStreamPromise;
	const data = await getStream(responseStream);

	t.is(data, 'ok');
	t.is(globalRetryCount, 1);
});

test('throws when cannot retry a Got stream', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('not ok');
	});

	let globalRetryCount = 0;

	const streamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		const fn = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream('');

			globalRetryCount = stream.retryCount;

			stream.resume();
			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				fn(createRetryStream());
			});

			stream.once('data', () => {
				stream.destroy(new Error('data event has been emitted'));
			});

			stream.once('error', reject);
			stream.once('end', resolve);
		};

		fn();
	});

	const error = await t.throwsAsync<HTTPError>(streamPromise, {
		instanceOf: HTTPError,
	});

	t.is(error?.response.statusCode, 500);
	t.is(error?.response.body, 'not ok');
	t.is(globalRetryCount, 2);
});

test('can attach only one retry listener to a stream', withServer, async (t, _server, got) => {
	const stream = got.stream('');

	t.notThrows(() => {
		stream.on('retry', () => {});
	});

	t.throws(() => {
		stream.on('retry', () => {});
	}, {
		message: 'A retry listener has been attached already.',
	});

	stream.destroy();
});

test('promise does not retry when body is a stream', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.statusCode = 500;
		response.end('not ok');
	});

	const body = new PassThroughStream();
	body.end('hello');

	const response = await got.post({
		retry: {
			methods: ['POST'],
		},
		body,
		throwHttpErrors: false,
	});

	t.is(response.retryCount, 0);
});

test('reuses request options on retry', withServer, async (t, server, got) => {
	let first = true;
	server.get('/', (request, response) => {
		if (first) {
			first = false;
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const {body, retryCount} = await got('', {timeout: {request: 1000}, responseType: 'json'});
	t.is(retryCount, 1);
	t.is((body as any).accept, 'application/json');
});

test('respects backoffLimit', withServer, async (t, server, got) => {
	let count = 0;
	let timestamp = Date.now();
	const data: number[] = [];

	server.get('/', (_request, response) => {
		count++;

		const now = Date.now();
		data.push(now - timestamp);
		timestamp = now;

		if (count === 3) {
			response.end(JSON.stringify(data));
		} else {
			response.statusCode = 408;
			response.end();
		}
	});

	const body = await got('', {
		retry: {
			backoffLimit: 0,
		},
	}).json<number[]>();

	t.is(body.length, 3);
	t.true(body[0]! < 400);
	t.true(body[1]! < 400);
	t.true(body[2]! < 400);
});
