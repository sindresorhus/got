import {Buffer} from 'node:buffer';
import {EventEmitter, once} from 'node:events';
import {PassThrough as PassThroughStream, Readable} from 'node:stream';
import type {Socket} from 'node:net';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import assert from 'node:assert/strict';
import is from '@sindresorhus/is';
import type {Handler} from 'express';
import getStream from 'get-stream';
import got, {
	HTTPError,
	RequestError,
	TimeoutError,
	UploadError,
} from '../source/index.js';
import type Request from '../source/core/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const retryAfterOn413 = 2;
const socketTimeout = 300;

test('Retry-After beyond the timer limit does not become an immediate retry', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		if (++requests === 1) {
			response.writeHead(503, {'retry-after': '2592000'}).end('try next month');
			return;
		}

		response.end('retried too early');
	});

	const error = await rejects(got('', {retry: {limit: 1}}), HTTPError);
	assert.strictEqual(error.response.statusCode, 503);
	assert.strictEqual(error.response.body, 'try next month');
	assert.strictEqual(requests, 1);
});

for (const retryAfter of ['2147484', '9999999999999999999999999999999999999999', 'Thu, 01 Jan 2099 00:00:00 GMT']) {
	test(`overflowing Retry-After ${retryAfter} preserves a non-throwing error response`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.writeHead(503, {'retry-after': retryAfter}).end('unavailable');
		});

		const response = await got('', {throwHttpErrors: false, retry: {limit: 1}});
		assert.strictEqual(response.statusCode, 503);
		assert.strictEqual(response.body, 'unavailable');
		assert.strictEqual(response.retryCount, 0);
		assert.strictEqual(requests, 1);
	});
}

for (const backoff of [2_147_483_648, Infinity]) {
	test(`custom retry delay ${backoff} does not overflow`, withServer, async (_t, server, got) => {
		let requests = 0;
		let retryHooks = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.writeHead(503).end();
		});

		await assert.rejects(got('', {
			retry: {limit: 1, calculateDelay: () => backoff},
			hooks: {
				beforeRetry: [() => {
					retryHooks++;
				}],
			},
		}), HTTPError);
		assert.strictEqual(requests, 1);
		assert.strictEqual(retryHooks, 0);
	});
}

test('calculateDelay can scale an overflowing server delay down to a supported delay', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.writeHead(++requests === 1 ? 503 : 200, {'retry-after': '2592000'}).end('done');
	});

	const response = await got('', {
		retry: {
			limit: 1, calculateDelay({computedValue, retryAfter}) {
				assert.strictEqual(computedValue, 2_592_000_000);
				assert.strictEqual(retryAfter, computedValue);
				return 1;
			},
		},
	});
	assert.strictEqual(response.body, 'done');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(requests, 2);
});

test('the maximum supported retry timer remains cancellable', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(503).end();
	});
	const controller = new AbortController();
	let calculated = false;

	await assert.rejects(got('', {
		signal: controller.signal,
		retry: {
			limit: 1,
			calculateDelay() {
				calculated = true;
				setImmediate(() => {
					controller.abort();
				});
				return 2_147_483_647;
			},
		},
	}), {code: 'ERR_ABORTED'});
	assert.strictEqual(calculated, true);
	assert.strictEqual(requests, 1);
});

test('beforeRetry body replacement updates the generated content length', withServer, async (_t, server, got) => {
	let requests = 0;
	server.put('/', async (request, response) => {
		if (++requests === 1) {
			await getStream(request);
			response.statusCode = 503;
			response.end();
			return;
		}

		response.end(request.headers['content-length']);
	});

	const body = await got.put('', {
		body: 'original payload',
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [error => {
				error.options.body = 'new';
			}],
		},
	}).text();

	assert.strictEqual(body, '3');
	assert.strictEqual(requests, 2);
});

for (const {name, createBody, expectedBody, expectedLength} of [
	{
		name: 'UTF-8 text', createBody: () => '€🙂', expectedBody: '€🙂', expectedLength: '7',
	},
	{
		name: 'a byte view', createBody: () => new Uint8Array([0, 110, 101, 119, 0]).subarray(1, 4), expectedBody: 'new', expectedLength: '3',
	},
	{
		name: 'empty text', createBody: () => '', expectedBody: '', expectedLength: '0',
	},
	{
		name: 'an unknown-length stream', createBody: () => Readable.from(['new', ' payload']), expectedBody: 'new payload', expectedLength: undefined,
	},
	{
		name: 'no body', createBody: () => undefined, expectedBody: '', expectedLength: '0',
	},
]) {
	test(`beforeRetry refreshes body framing for ${name}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.put('/', async (request, response) => {
			const body = await getStream(request);
			if (++requests === 1) {
				assert.strictEqual(body, 'original payload');
				response.writeHead(503).end();
				return;
			}

			response.json({body, contentLength: request.headers['content-length']});
		});

		const result = await got.put('', {
			body: 'original payload',
			retry: {limit: 1, backoffLimit: 0, noise: 0},
			timeout: {request: 1000},
			hooks: {
				beforeRetry: [error => {
					error.options.body = createBody();
				}],
			},
		}).json<{body: string; contentLength?: string}>();

		assert.strictEqual(result.body, expectedBody);
		assert.strictEqual(result.contentLength, expectedLength);
		assert.strictEqual(requests, 2);
	});
}

test('beforeRetry preserves explicitly reassigned content length for a stream', withServer, async (_t, server, got) => {
	let requests = 0;
	server.put('/', async (request, response) => {
		const body = await getStream(request);
		if (++requests === 1) {
			response.writeHead(503).end();
			return;
		}

		response.json({body, contentLength: request.headers['content-length']});
	});

	const result = await got.put('', {
		body: 'original payload',
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [error => {
				error.options.body = Readable.from(['replacement body']);
				// Reassigning the same value still explicitly supplies the stream length.
				error.options.headers['content-length'] = '16';
			}],
		},
	}).json<{body: string; contentLength: string}>();

	assert.deepStrictEqual(result, {body: 'replacement body', contentLength: '16'});
	assert.strictEqual(requests, 2);
});

test('failure to reopen an iterable upload rejects the retried request', withServer, async (_t, server, got) => {
	server.put('/', async (request, response) => {
		await getStream(request);
		response.statusCode = 503;
		response.end();
	});
	const cause = new Error('Upload source is no longer available');
	let iterations = 0;
	const body = {
		[Symbol.iterator]() {
			if (++iterations > 1) {
				throw cause;
			}

			return ['payload'][Symbol.iterator]();
		},
	};
	const error = await rejects(got.put('', {
		body,
		retry: {limit: 1, backoffLimit: 0, noise: 0},
	}), errorMatching(UploadError, {message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(iterations, 2);
});

test('failure to reopen an async iterable upload rejects the retried request', withServer, async (_t, server, got) => {
	server.put('/', async (request, response) => {
		await getStream(request);
		response.statusCode = 503;
		response.end();
	});
	const cause = new Error('Async upload source is no longer available');
	let iterations = 0;
	const body = {
		[Symbol.asyncIterator]() {
			if (++iterations > 1) {
				throw cause;
			}

			return (async function * () {
				yield 'payload';
			})();
		},
	};
	const error = await rejects(got.put('', {
		body,
		retry: {limit: 1, backoffLimit: 0, noise: 0},
	}), errorMatching(UploadError, {message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(iterations, 2);
});

for (const asynchronous of [false, true]) {
	test(`retries open reusable upload sources only when sending with async ${asynchronous}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.put('/', async (request, response) => {
			const body = await getStream(request);
			response.statusCode = ++requests === 1 ? 503 : 200;
			response.end(body);
		});
		let iterations = 0;
		const open = () => {
			iterations++;
			return ['payload'][Symbol.iterator]();
		};

		const body = asynchronous
			? {
				[Symbol.asyncIterator]() {
					const iterator = open();
					return {
						async next() {
							return iterator.next();
						},
					};
				},
			}
			: {[Symbol.iterator]: open};

		assert.strictEqual(await got.put('', {body, retry: {limit: 1, backoffLimit: 0, noise: 0}}).text(), 'payload');
		assert.strictEqual(iterations, 2);
		assert.strictEqual(requests, 2);
	});
}

const handler413: Handler = (_request, response) => {
	response.writeHead(413, {
		'Retry-After': retryAfterOn413,
	});
	response.end();
};

const createSocketTimeoutStream = (url: string): http.ClientRequest => {
	if (url.includes('https:')) {
		return https.request(url, {
			timeout: 1,
		});
	}

	return http.request(url, {
		timeout: socketTimeout,
	});
};

type RequestEndErrorScenario = 'request-error-first' | 'end-callback-only';

const createRequestWithEndError = (scenario: RequestEndErrorScenario): http.ClientRequest => {
	const request = new EventEmitter() as http.ClientRequest;
	(request as any).end = (callback: (error: Error) => void) => {
		const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), {code: 'ECONNREFUSED'});

		queueMicrotask(() => {
			if (scenario === 'request-error-first') {
				request.emit('error', connectionError);
			}

			callback(connectionError);
		});
	};

	(request as any).destroyed = false;
	(request as any).destroy = () => {
		(request as any).destroyed = true;
		return request;
	};

	(request as any).writable = true;
	(request as any).writableEnded = false;

	return request;
};

test('works on timeout', withServer, async (_t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		response.end('who`s there?');
	});

	assert.strictEqual((await got({
		timeout: {
			socket: socketTimeout,
		},
		request(...arguments_: [
			string | URL | http.RequestOptions,
			(http.RequestOptions | ((response: http.IncomingMessage) => void))?,
			((response: http.IncomingMessage) => void)?,
		]) {
			if (knocks === 1) {
				// @ts-expect-error Overload error
				return http.request(...arguments_);
			}

			knocks++;
			return createSocketTimeoutStream(server.url);
		},
	})).body, 'who`s there?');
});

test('retry function gets iteration count', withServer, async (_t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
			return;
		}

		response.statusCode = 500;
		response.end();
	});

	let calls = 0;
	await got({
		retry: {
			calculateDelay({attemptCount}) {
				calls++;
				assert.strictEqual(is.number(attemptCount), true);
				return attemptCount < 2 ? 1 : 0;
			},
		},
	});

	assert.strictEqual(calls, 1);
});

test('setting to `0` disables retrying', async _t => {
	let capturedAttemptCount: number | undefined;

	await assert.rejects(got('https://example.com', {
		timeout: {socket: socketTimeout},
		retry: {
			calculateDelay({attemptCount}) {
				capturedAttemptCount = attemptCount;
				return 0;
			},
		},
		request: () => createSocketTimeoutStream('https://example.com'),
	}), errorMatching(TimeoutError, {message: `Timeout awaiting 'socket' for ${socketTimeout}ms`}));

	assert.strictEqual(capturedAttemptCount, 1);
});

test('custom retries', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let hasTried = false;
	const error = await rejects(got({
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
	assert.strictEqual(error?.response.statusCode, 500);
	assert.strictEqual(hasTried, true);
});

test('custom retries async', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let hasTried = false;
	const error = await rejects(got({
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
	assert.strictEqual(error?.response.statusCode, 500);
	assert.strictEqual(hasTried, true);
});

test('custom error codes', async _t => {
	const errorCode = 'OH_SNAP';
	let capturedErrorCode: string | undefined;

	const error = await rejects(got('https://example.com', {
		request() {
			const emitter = new EventEmitter() as http.ClientRequest;
			(emitter as any).end = () => {};
			(emitter as any).destroy = () => {};
			(emitter as any).writable = true;
			(emitter as any).writableEnded = false;

			const error = new Error('Snap!');
			(error as Error & {code: typeof errorCode}).code = errorCode;
			setTimeout(() => {
				emitter.emit('error', error);
			}, 0);

			return emitter;
		},
		retry: {
			calculateDelay({error}) {
				capturedErrorCode = error.code;
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

	assert.strictEqual(capturedErrorCode, errorCode);
	assert.strictEqual(error?.code, errorCode);
});

test('retries when ClientRequest emits a connection error before its end callback receives it', async _t => {
	let attemptCount = 0;
	let beforeRetryCount = 0;
	let beforeErrorCount = 0;

	const error = await rejects(got('http://localhost', {
		request() {
			attemptCount++;
			return createRequestWithEndError('request-error-first');
		},
		retry: {
			limit: 2,
			backoffLimit: 1,
			noise: 0,
		},
		hooks: {
			beforeRetry: [error => {
				beforeRetryCount++;
				assert.strictEqual(error.code, 'ECONNREFUSED');
			}],
			beforeError: [error => {
				beforeErrorCount++;
				return error;
			}],
		},
	}), RequestError);

	assert.strictEqual(attemptCount, 3);
	assert.strictEqual(beforeRetryCount, 2);
	assert.strictEqual(beforeErrorCount, 1);
	assert.strictEqual(error?.code, 'ECONNREFUSED');
	assert.strictEqual(error?.request?.retryCount, 2);
});

test('recovers when retrying after a request end error', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let attemptCount = 0;
	const response = await got({
		request(url, options) {
			attemptCount++;

			return attemptCount === 1 ? createRequestWithEndError('end-callback-only') : http.request(url, options);
		},
		retry: {
			limit: 1,
			backoffLimit: 1,
			noise: 0,
		},
	});

	assert.strictEqual(response.body, 'ok');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(attemptCount, 2);
});

test('end callback errors do not finish the stream before retrying', async _t => {
	const stream = got.stream('http://localhost', {
		request: () => createRequestWithEndError('end-callback-only'),
		retry: {
			limit: 1,
			backoffLimit: 1,
			noise: 0,
		},
	});
	let finishCount = 0;
	stream.on('finish', () => {
		finishCount++;
	});

	await once(stream, 'retry');

	assert.strictEqual(finishCount, 0);
	assert.strictEqual(stream.writableFinished, false);
});

test('respects 413 Retry-After', withServer, async (_t, server, got) => {
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
	assert.strictEqual(statusCode, 413);
	assert.strictEqual(Number(body) >= retryAfterOn413 * 1000, true);
});

for (const statusCode of [413, 429, 503]) {
	test(`retries immediately on ${statusCode} with Retry-After of 0`, withServer, async (_t, server, got) => {
		let requestCount = 0;
		server.get('/', (_request, response) => {
			requestCount++;
			if (requestCount === 1) {
				response.writeHead(statusCode, {'Retry-After': '0'}).end();
				return;
			}

			response.end('ok');
		});
		const response = await got({
			throwHttpErrors: false,
			retry: {
				limit: 1,
				calculateDelay({computedValue, retryAfter}) {
					assert.strictEqual(retryAfter, 0);
					assert.strictEqual(computedValue, 1);
					return 1;
				},
			},
		});
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.retryCount, 1);
	});
}

test('ignores an invalid Retry-After header', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.writeHead(503, {'Retry-After': 'not-a-date'}).end();
			return;
		}

		response.end('ok');
	});

	const response = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			calculateDelay({computedValue, retryAfter}) {
				assert.strictEqual(retryAfter, undefined);
				assert.strictEqual(Number.isNaN(computedValue), false);
				return 1;
			},
		},
	});
	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.retryCount, 1);
});

for (const retryAfterHeader of ['Infinity', '0x10', '1.5', '']) {
	test(`ignores Retry-After with invalid numeric syntax: ${JSON.stringify(retryAfterHeader)}`, withServer, async (_t, server, got) => {
		let requestCount = 0;
		server.get('/', (_request, response) => {
			requestCount++;
			if (requestCount === 1) {
				response.writeHead(503, {'Retry-After': retryAfterHeader}).end();
				return;
			}

			response.end('ok');
		});

		const response = await got({
			throwHttpErrors: false,
			retry: {
				limit: 1,
				calculateDelay({retryAfter}) {
					assert.strictEqual(retryAfter, undefined);
					return 1;
				},
			},
		});
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.retryCount, 1);
	});
}

test('respects 413 Retry-After with RFC-1123 timestamp', withServer, async (_t, server, got) => {
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
	assert.strictEqual(statusCode, 413);
	assert.strictEqual(Date.now() >= Date.parse(body), true);
});

test('doesn\'t retry on 413 with empty statusCodes and methods', withServer, async (_t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			statusCodes: [],
			methods: [],
		},
	});
	assert.strictEqual(statusCode, 413);
	assert.strictEqual(retryCount, 0);
});

test('doesn\'t retry on 413 with empty methods', withServer, async (_t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			statusCodes: [413],
			methods: [],
		},
	});
	assert.strictEqual(statusCode, 413);
	assert.strictEqual(retryCount, 0);
});

test('doesn\'t retry on 413 without Retry-After header', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 413;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false,
	});
	assert.strictEqual(retryCount, 0);
});

test('retries on 503 without Retry-After header', withServer, async (_t, server, got) => {
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
	assert.strictEqual(retryCount, 1);
});

test('doesn\'t retry on streams', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	let calculateDelayCalls = 0;
	const stream = got.stream({
		timeout: {
			request: 1,
		},
		retry: {
			calculateDelay() {
				calculateDelayCalls++;
				return 0;
			},
		},
	});
	await assert.rejects(once(stream, 'response'), TimeoutError);

	assert.strictEqual(calculateDelayCalls, 0, 'Retries on streams');
});

test('doesn\'t retry if Retry-After header is greater than maxRetryAfter', withServer, async (_t, server, got) => {
	server.get('/', handler413);

	const {retryCount} = await got({
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false,
	});
	assert.strictEqual(retryCount, 0);
});

test('doesn\'t retry when set to 0', withServer, async (_t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 0,
		},
	});
	assert.strictEqual(statusCode, 413);
	assert.strictEqual(retryCount, 0);
});

test('works when defaults.options.retry is a number', withServer, async (_t, server, got) => {
	server.get('/', handler413);

	const instance = got.extend({
		retry: {
			limit: 2,
		},
	});

	const {retryCount} = await instance({
		throwHttpErrors: false,
	});
	assert.strictEqual(retryCount, 2);
});

test('retry function can throw', withServer, async (_t, server, got) => {
	server.get('/', handler413);

	const error = 'Simple error';
	await assert.rejects(got({
		retry: {
			calculateDelay() {
				throw new Error(error);
			},
		},
	}), {message: error});
});

test('does not retry on POST', withServer, async (_t, server, got) => {
	server.post('/', () => {});

	let retried = false;

	await assert.rejects(got.post({
		timeout: {
			request: 200,
		},
		hooks: {
			beforeRetry: [
				() => {
					retried = true;
				},
			],
		},
	}), TimeoutError);

	assert.strictEqual(retried, false, 'Retries on POST requests');
});

test('retries QUERY with JSON body by default', withServer, async (_t, server, got) => {
	const attempts: Array<{method: string; body: string; contentType: string | undefined}> = [];
	const payload = {
		query: true,
	};

	server.all('/', async (request, response) => {
		const body = await getStream(request);
		attempts.push({
			method: request.method,
			body,
			contentType: request.headers['content-type'],
		});

		if (attempts.length === 1) {
			response.statusCode = 500;
			response.end();
			return;
		}

		response.end(body);
	});

	const {body, retryCount} = await got.query({
		json: payload,
		retry: {
			limit: 1,
		},
	});

	assert.strictEqual(retryCount, 1);
	assert.deepStrictEqual(JSON.parse(body), payload);
	assert.deepStrictEqual(attempts, [
		{
			method: 'QUERY',
			body: '{"query":true}',
			contentType: 'application/json',
		},
		{
			method: 'QUERY',
			body: '{"query":true}',
			contentType: 'application/json',
		},
	]);
});

test('does not break on redirect', withServer, async (_t, server, got) => {
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

	await assert.rejects(got('redirect'), {message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/v});
	assert.strictEqual(tries, 1);
});

test('does not destroy the socket on HTTP error', withServer, async (_t, server, got) => {
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

	assert.strictEqual(sockets.length, 2);
	assert.strictEqual(sockets[0], sockets[1]);

	agent.destroy();
});

test('can retry a Got stream', withServer, async (_t, server, got) => {
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

		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream('');

			globalRetryCount = stream.retryCount;

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();

			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				resolve(writeStream);
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const data = await getStream(responseStream);

	assert.strictEqual(data, 'ok');
	assert.strictEqual(globalRetryCount, 1);
});

test('can retry a Got stream with allowAbsoluteUrls false', withServer, async (_t, server, got) => {
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

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream('', {allowAbsoluteUrls: false});

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				resolve(writeStream);
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const data = await getStream(responseStream);

	assert.strictEqual(data, 'ok');
});

test('`allowAbsoluteUrls: false` rejects an absolute URL passed to a Got stream retry', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('not ok');
	});

	const error = await new Promise<Error>(resolve => {
		const stream = got.stream('', {allowAbsoluteUrls: false});
		stream.resume();
		stream.once('error', () => {});
		stream.once('retry', (_retryCount, _error, createRetryStream) => {
			const retryStream = createRetryStream({url: `${server.url}/other`});
			retryStream.once('error', resolve);
			retryStream.resume();
		});
	});

	assert.strictEqual(error.message, 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set');
});

test('throws when cannot retry a Got stream', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('not ok');
	});

	let globalRetryCount = 0;

	const streamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream('');

			globalRetryCount = stream.retryCount;

			stream.resume();
			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('data', () => {
				stream.destroy(new Error('data event has been emitted'));
			});

			stream.once('error', reject);
			stream.once('end', resolve);
		};

		function_();
	});

	const error = await rejects(streamPromise, HTTPError);

	assert.strictEqual(error?.response.statusCode, 500);
	assert.strictEqual(error?.response.body, 'not ok');
	assert.strictEqual(globalRetryCount, 2);
});

test('can attach only one retry listener to a stream', withServer, async (_t, _server, got) => {
	const stream = got.stream('');

	assert.doesNotThrow(() => {
		stream.on('retry', () => {});
	});

	assert.throws(() => {
		stream.on('retry', () => {});
	}, {
		message: 'A retry listener has been attached already.',
	});

	stream.destroy();
});

test('createRetryStream accepts options', withServer, async (_t, server, got) => {
	let returnServerError = true;
	let receivedCustomHeader = false;

	server.get('/', (request, response) => {
		if (request.headers['x-custom-header'] === 'custom-value') {
			receivedCustomHeader = true;
		}

		if (returnServerError) {
			response.statusCode = 500;
			response.end('not ok');
			returnServerError = false;
			return;
		}

		response.end('ok');
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream('');

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();

			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				// Pass custom options on retry
				function_(createRetryStream({
					headers: {
						'x-custom-header': 'custom-value',
					},
				}));
			});

			stream.once('error', reject);
			stream.once('end', () => {
				resolve(writeStream);
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const data = await getStream(responseStream);

	assert.strictEqual(data, 'ok');
	assert.strictEqual(receivedCustomHeader, true);
});

test('createRetryStream re-copies piped headers on retry', withServer, async (_t, server, got) => {
	let returnServerError = true;

	server.put('/', (request, response) => {
		if (returnServerError) {
			returnServerError = false;
			response.statusCode = 500;
			response.end('not ok');
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;
		let attempt = 0;

		const function_ = (retryStream?: Request) => {
			attempt++;
			const stream = retryStream ?? got.stream.put('', {copyPipedHeaders: true});

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			const sourceStream = new PassThroughStream() as PassThroughStream & {headers: Record<string, string>};
			sourceStream.headers = {
				'x-custom-header': attempt === 1 ? 'first-value' : 'second-value',
			};

			sourceStream.pipe(stream);
			sourceStream.end('request body');
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				if (stream.retryCount === 1) {
					resolve(writeStream);
				}
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const headers = JSON.parse(await getStream(responseStream)) as Record<string, string>;

	assert.strictEqual(headers['x-custom-header'], 'second-value');
});

test('createRetryStream preserves explicit header omissions after undefined header pruning', withServer, async (_t, server, got) => {
	let returnServerError = true;

	server.put('/', (request, response) => {
		if (returnServerError) {
			returnServerError = false;
			response.statusCode = 500;
			response.end('not ok');
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream.put('', {
				copyPipedHeaders: true,
				headers: {
					authorization: undefined,
				},
			});

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			const sourceStream = new PassThroughStream() as PassThroughStream & {headers: Record<string, string>};
			sourceStream.headers = {
				authorization: 'Bearer piped-token',
			};

			sourceStream.pipe(stream);
			sourceStream.end('request body');
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				if (stream.retryCount === 1) {
					resolve(writeStream);
				}
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const headers = JSON.parse(await getStream(responseStream)) as Record<string, string | undefined>;

	assert.strictEqual(headers.authorization, undefined);
});

test('createRetryStream re-copies piped headers after internal header additions on previous attempt', withServer, async (_t, server, got) => {
	let returnServerError = true;
	let attempt = 0;

	server.put('/', (request, response) => {
		if (returnServerError) {
			returnServerError = false;
			response.statusCode = 500;
			response.end('not ok');
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			attempt++;
			const stream = retryStream ?? got.stream.put('', {copyPipedHeaders: true});

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			const sourceStream = new PassThroughStream() as PassThroughStream & {headers: Record<string, string>};
			sourceStream.headers = attempt === 1
				? {}
				: {'accept-encoding': 'identity'};

			sourceStream.pipe(stream);
			sourceStream.end('request body');
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				if (stream.retryCount === 1) {
					resolve(writeStream);
				}
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const headers = JSON.parse(await getStream(responseStream)) as Record<string, string>;

	assert.strictEqual(headers['accept-encoding'], 'identity');
});

test('createRetryStream preserves header omission from direct header mutation', withServer, async (_t, server, got) => {
	let returnServerError = true;

	server.put('/', (request, response) => {
		if (returnServerError) {
			returnServerError = false;
			response.statusCode = 500;
			response.end('not ok');
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream.put('', {copyPipedHeaders: true});
			stream.options.headers.authorization = undefined;

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			const sourceStream = new PassThroughStream() as PassThroughStream & {headers: Record<string, string>};
			sourceStream.headers = {
				authorization: 'Bearer piped-token',
			};

			sourceStream.pipe(stream);
			sourceStream.end('request body');
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				if (stream.retryCount === 1) {
					resolve(writeStream);
				}
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const headers = JSON.parse(await getStream(responseStream)) as Record<string, string | undefined>;

	assert.strictEqual(headers.authorization, undefined);
});

test('createRetryStream preserves mixed-case header omission from direct header mutation', withServer, async (_t, server, got) => {
	let returnServerError = true;

	server.put('/', (request, response) => {
		if (returnServerError) {
			returnServerError = false;
			response.statusCode = 500;
			response.end('not ok');
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			const stream = retryStream ?? got.stream.put('', {copyPipedHeaders: true});
			stream.options.headers.Authorization = undefined;

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			const sourceStream = new PassThroughStream() as PassThroughStream & {headers: Record<string, string>};
			sourceStream.headers = {
				authorization: 'Bearer piped-token',
			};

			sourceStream.pipe(stream);
			sourceStream.end('request body');
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				if (stream.retryCount === 1) {
					resolve(writeStream);
				}
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const headers = JSON.parse(await getStream(responseStream)) as Record<string, string | undefined>;

	assert.strictEqual(headers.authorization, undefined);
});

test('createRetryStream keeps username/password authorization precedence over piped authorization', withServer, async (_t, server, got) => {
	let returnServerError = true;
	let attempt = 0;

	server.put('/', (request, response) => {
		if (returnServerError) {
			returnServerError = false;
			response.statusCode = 500;
			response.end('not ok');
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const function_ = (retryStream?: Request) => {
			attempt++;
			const stream = retryStream ?? got.stream.put('', {
				copyPipedHeaders: true,
				username: 'foo',
				password: 'bar',
			});

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();
			const sourceStream = new PassThroughStream() as PassThroughStream & {headers: Record<string, string>};
			sourceStream.headers = attempt === 1
				? {}
				: {authorization: 'Bearer retry-token'};

			sourceStream.pipe(stream);
			sourceStream.end('request body');
			stream.pipe(writeStream);

			stream.once('retry', (_retryCount, _error, createRetryStream) => {
				function_(createRetryStream());
			});

			stream.once('error', reject);
			stream.once('end', () => {
				if (stream.retryCount === 1) {
					resolve(writeStream);
				}
			});
		};

		function_();
	});

	const responseStream = await responseStreamPromise;
	const headers = JSON.parse(await getStream(responseStream)) as Record<string, string>;

	assert.strictEqual(headers.authorization, 'Basic Zm9vOmJhcg==');
});

test('promise does not retry when body is a stream', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.retryCount, 0);
});

test('reuses request options on retry', withServer, async (_t, server, got) => {
	let first = true;
	server.get('/', (request, response) => {
		if (first) {
			first = false;
			return;
		}

		response.end(JSON.stringify(request.headers));
	});

	const {body, retryCount} = await got('', {timeout: {request: 1000}, responseType: 'json'});
	assert.strictEqual(retryCount, 1);
	assert.strictEqual((body as any).accept, 'application/json');
});

test('respects backoffLimit', withServer, async (_t, server, got) => {
	let requestCount = 0;
	const computedValues: number[] = [];

	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 3) {
			response.end();
		} else {
			response.statusCode = 408;
			response.end();
		}
	});

	const {retryCount} = await got('', {
		retry: {
			backoffLimit: 10,
			noise: 0,
			calculateDelay({computedValue}) {
				computedValues.push(computedValue);
				return computedValue;
			},
		},
	});

	assert.strictEqual(retryCount, 2);
	assert.strictEqual(requestCount, 3);
	assert.deepStrictEqual(computedValues, [10, 10]);
});

test('enforceRetryRules respects statusCodes with custom calculateDelay', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		// Return 500 on first request, 429 on second, 200 on third
		if (requestCount === 1) {
			response.statusCode = 500;
		} else if (requestCount === 2) {
			response.statusCode = 429;
		}

		response.end();
	});

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 5,
			statusCodes: [429], // Should only retry on 429
			enforceRetryRules: true,
			calculateDelay({attemptCount}) {
				// Custom delay but should still respect statusCodes
				return attemptCount * 100;
			},
		},
	});

	// Should not retry on 500 (not in statusCodes list)
	assert.strictEqual(statusCode, 500);
	assert.strictEqual(retryCount, 0);
});

test('enforces retry rules by default with custom calculateDelay', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.statusCode = 500;
		} else if (requestCount === 2) {
			response.statusCode = 429;
		}

		response.end();
	});

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 5,
			statusCodes: [429],
			calculateDelay({attemptCount}) {
				return attemptCount * 100;
			},
		},
	});

	assert.strictEqual(statusCode, 500);
	assert.strictEqual(retryCount, 0);
});

test('enforceRetryRules respects limit with custom calculateDelay', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		response.statusCode = 500;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 2,
			enforceRetryRules: true,
			calculateDelay({attemptCount}) {
				// With enforceRetryRules, limit is enforced automatically
				return attemptCount * 100;
			},
		},
	});

	// Should stop at limit even with custom calculateDelay
	assert.strictEqual(retryCount, 2);
	assert.strictEqual(requestCount, 3); // Initial request + 2 retries
});

test('retries on stream errors like EPIPE when configured', async _t => {
	let attemptCount = 0;
	let retryCount = 0;

	const error = await rejects(got.post('https://example.com', {
		retry: {
			limit: 2,
			methods: ['POST'],
			errorCodes: ['EPIPE'],
		},
		hooks: {
			beforeRetry: [
				() => {
					retryCount++;
				},
			],
		},
		request() {
			attemptCount++;

			const emitter = new EventEmitter() as http.ClientRequest;
			(emitter as any).end = (callback: any) => {
				// Simulate EPIPE error from Node.js during write/end
				// This mimics what happens when a socket is torn down (e.g., AWS Lambda pause)
				const error = new Error('write EPIPE');
				(error as NodeJS.ErrnoException).code = 'EPIPE';

				if (callback) {
					setTimeout(() => {
						callback(error);
					}, 10);
				}
			};

			emitter.destroyed = false;

			(emitter as any).destroy = () => {
				emitter.destroyed = true;
			};

			(emitter as any).write = () => true;

			(emitter as any).writable = true;
			(emitter as any).writableEnded = false;

			return emitter;
		},
	}), {code: 'EPIPE'});

	// Should retry twice (limit: 2) for a total of 3 attempts
	assert.strictEqual(attemptCount, 3);
	assert.strictEqual(retryCount, 2);
	assert.strictEqual(error?.code, 'EPIPE');
});

test('does not retry on stream errors when not in errorCodes', async _t => {
	let attemptCount = 0;

	const error = await rejects(got('https://example.com', {
		retry: {
			limit: 2,
			errorCodes: [], // Empty list means no errors should be retried
		},
		request() {
			attemptCount++;

			const emitter = new EventEmitter() as http.ClientRequest;
			(emitter as any).end = (callback: any) => {
				const error = new Error('write ETEST');
				(error as NodeJS.ErrnoException).code = 'ETEST';

				if (callback) {
					setTimeout(() => {
						callback(error);
					}, 10);
				}
			};

			emitter.destroyed = false;

			(emitter as any).destroy = () => {
				emitter.destroyed = true;
			};

			(emitter as any).write = () => true;

			(emitter as any).writable = true;
			(emitter as any).writableEnded = false;

			return emitter;
		},
	}), {code: 'ETEST'});

	// Should NOT retry since errorCodes is empty
	assert.strictEqual(attemptCount, 1);
	assert.strictEqual(error?.code, 'ETEST');
});

test('does not retry after promise settles (issue #1489)', async _t => {
	let retryTriggered = false;

	const response = await got('https://example.com', {
		retry: {limit: 2, errorCodes: ['ECONNRESET']},
		hooks: {
			beforeRetry: [() => {
				retryTriggered = true;
			}],
		},
		request() {
			const emitter = new EventEmitter() as http.ClientRequest;
			(emitter as any).end = () => {};
			emitter.destroyed = false;
			(emitter as any).destroy = () => {
				emitter.destroyed = true;
			};

			(emitter as any).write = () => true;
			(emitter as any).writable = true;
			(emitter as any).writableEnded = false;

			setTimeout(() => {
				const incomingMessage = new PassThroughStream() as unknown as http.IncomingMessage;
				incomingMessage.statusCode = 200;
				incomingMessage.headers = {};

				emitter.emit('response', incomingMessage);

				setImmediate(() => {
					// @ts-expect-error PassThrough method
					incomingMessage.end('ok');
				});

				// Late error after response - should NOT trigger retry
				setTimeout(() => {
					const error = new Error('read ECONNRESET');
					(error as NodeJS.ErrnoException).code = 'ECONNRESET';
					emitter.emit('error', error);
				}, 10);
			}, 0);

			return emitter;
		},
		throwHttpErrors: false,
	});

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(retryTriggered, false);
});

test('does not retry with a consumed generator body', withServer, async (_t, server, got) => {
	const bodies: string[] = [];

	server.post('/', async (request, response) => {
		bodies.push(await getStream(request));

		if (bodies.length === 1) {
			response.statusCode = 503;
		}

		response.end();
	});

	async function * body() {
		yield 'part1';
		yield 'part2';
	}

	await assert.rejects(got.post({
		body: body(),
		retry: {
			limit: 1,
			methods: ['POST'],
			calculateDelay: () => 1,
		},
	}), {
		message: 'Cannot retry with consumed body stream',
	});

	assert.deepStrictEqual(bodies, ['part1part2']);
});

test('retries with a FormData body', withServer, async (_t, server, got) => {
	const bodies: string[] = [];

	server.post('/', async (request, response) => {
		bodies.push(await getStream(request));

		if (bodies.length < 3) {
			response.statusCode = 503;
		}

		response.end();
	});

	const form = new FormData();
	form.append('field', 'value');

	await got.post({
		body: form,
		retry: {
			limit: 2,
			methods: ['POST'],
			calculateDelay: () => 1,
		},
	});

	assert.strictEqual(bodies.length, 3);
	for (const body of bodies) {
		assert.strictEqual(body.includes('value'), true);
	}
});

test('retries with a FormData body using content-type changed in beforeRetry hook', withServer, async (_t, server, got) => {
	const contentTypes: Array<string | undefined> = [];

	server.post('/', async (request, response) => {
		await request.toArray();
		contentTypes.push(request.headers['content-type']);

		if (contentTypes.length === 1) {
			response.statusCode = 503;
		}

		response.end();
	});

	const form = new FormData();
	form.append('field', 'value');

	await got.post({
		body: form,
		retry: {
			limit: 1,
			methods: ['POST'],
			calculateDelay: () => 1,
		},
		hooks: {
			beforeRetry: [({options}) => {
				options.headers['content-type'] = 'text/plain';
			}],
		},
	});

	assert.strictEqual(contentTypes[0]!.startsWith('multipart/form-data; boundary='), true);
	assert.strictEqual(contentTypes[1], 'text/plain');
});

test('a zero backoff limit retries without disabling retry rules', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.statusCode = requests === 1 ? 503 : 200;
		response.end('ok');
	});

	const response = await got('', {
		retry: {
			limit: 1,
			backoffLimit: 0,
			noise: 0,
		},
	});

	assert.strictEqual(response.body, 'ok');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(requests, 2);
});

test('zero backoff still stops at the retry limit', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.statusCode = 503;
		response.end();
	});

	const response = await got('', {
		throwHttpErrors: false,
		retry: {limit: 2, backoffLimit: 0, noise: 0},
	});

	assert.strictEqual(response.retryCount, 2);
	assert.strictEqual(requests, 3);
});

test('a custom zero delay can disable a retry with zero backoff', withServer, async (_t, server, got) => {
	let requests = 0;
	const delays: number[] = [];
	server.get('/', (_request, response) => {
		requests++;
		response.statusCode = 503;
		response.end();
	});

	const response = await got('', {
		throwHttpErrors: false,
		retry: {
			backoffLimit: 0,
			noise: 0,
			calculateDelay({computedValue}) {
				delays.push(computedValue);
				return 0;
			},
		},
	});

	assert.strictEqual(response.retryCount, 0);
	assert.strictEqual(requests, 1);
	assert.deepStrictEqual(delays, [1]);
});

for (const statusCode of [404, 413]) {
	test(`zero backoff does not make status ${statusCode} retryable`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.statusCode = statusCode;
			response.end();
		});

		const response = await got('', {
			throwHttpErrors: false,
			retry: {backoffLimit: 0, noise: 0},
		});

		assert.strictEqual(response.retryCount, 0);
		assert.strictEqual(requests, 1);
	});
}

test('negative retry noise cannot produce a nonpositive computed delay', withServer, async (_t, server, got) => {
	let requests = 0;
	const delays: number[] = [];
	server.get('/', (_request, response) => {
		requests++;
		response.statusCode = requests === 1 ? 503 : 200;
		response.end();
	});

	await got('', {
		retry: {
			backoffLimit: 1,
			noise: -100,
			calculateDelay({computedValue}) {
				delays.push(computedValue);
				return computedValue;
			},
		},
	});

	assert.strictEqual(requests, 2);
	assert.deepStrictEqual(delays, [1]);
});

test('requestUrl preserves the original URL when beforeRetry changes the destination', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.statusCode = 503;
		response.end('retry');
	});
	server.get('/recovered', (request, response) => {
		response.end(request.originalUrl);
	});

	const response = await got('original?initial=yes', {
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [error => {
				error.options.url = new URL('/recovered?initial=yes', server.url);
			}],
		},
	});

	assert.strictEqual(response.body, '/recovered?initial=yes');
	assert.strictEqual(response.url, `${server.url}/recovered?initial=yes`);
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(response.requestUrl.href, `${server.url}/original?initial=yes`);
});

test('a zero maxRetryAfter allows a server-requested immediate retry', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		if (requests === 1) {
			response.writeHead(429, {'retry-after': '0'}).end();
			return;
		}

		response.end('ok');
	});

	const response = await got('', {retry: {maxRetryAfter: 0, limit: 1}});

	assert.strictEqual(response.body, 'ok');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(requests, 2);
});

test('requestUrl survives a redirect followed by a retry', withServer, async (_t, server, got) => {
	let attempts = 0;
	server.get('/original', (_request, response) => {
		response.redirect('/destination');
	});
	server.get('/destination', (_request, response) => {
		response.statusCode = ++attempts === 1 ? 503 : 200;
		response.end('done');
	});

	const response = await got('original', {retry: {limit: 1, backoffLimit: 0, noise: 0}});

	assert.strictEqual(response.body, 'done');
	assert.strictEqual(attempts, 2);
	assert.strictEqual(response.url, `${server.url}/destination`);
	assert.strictEqual(response.requestUrl.href, `${server.url}/original`);
});

test('requestUrl survives an afterResponse retry to another path', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	server.get('/recovered', (_request, response) => {
		response.end('recovered');
	});

	const response = await got('original', {
		hooks: {
			afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({url: 'recovered'})],
		},
	});

	assert.strictEqual(response.body, 'recovered');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(response.url, `${server.url}/recovered`);
	assert.strictEqual(response.requestUrl.href, `${server.url}/original`);
});

test('failed retries retain the original requestUrl across multiple destinations', withServer, async (_t, server, got) => {
	const paths: string[] = [];
	server.get('/:attempt', (request, response) => {
		paths.push(request.path);
		response.statusCode = 503;
		response.end('unavailable');
	});

	const error = await rejects(got('0', {
		retry: {limit: 2, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [(error, retryCount) => {
				error.options.url = new URL(`/${retryCount}`, server.url);
			}],
		},
	}), HTTPError);

	assert.deepStrictEqual(paths, ['/0', '/1', '/2']);
	assert.strictEqual(error.response.url, `${server.url}/2`);
	assert.strictEqual(error.response.requestUrl.href, `${server.url}/0`);
});

test('retry streams retain independent snapshots of the original requestUrl', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.statusCode = 503;
		response.end('retry');
	});
	server.get('/recovered', (_request, response) => {
		response.end('recovered');
	});

	const original = got.stream('original', {retry: {limit: 1, backoffLimit: 0, noise: 0}});
	const retried = await new Promise<Request>((resolve, reject) => {
		original.once('error', reject);
		original.once('retry', (_retryCount, _error, createRetryStream) => {
			resolve(createRetryStream({url: 'recovered'}));
		});
		original.resume();
	});

	assert.strictEqual(await getStream(retried), 'recovered');
	assert.strictEqual(retried.response?.url, `${server.url}/recovered`);
	assert.strictEqual(retried.requestUrl?.href, `${server.url}/original`);
	assert.notStrictEqual(retried.requestUrl, original.requestUrl);
	retried.requestUrl.searchParams.set('later', 'change');
	assert.strictEqual(original.requestUrl?.href, `${server.url}/original`);
});

for (const statusCode of [413, 503]) {
	test(`past Retry-After dates allow immediate ${statusCode} retries with a zero limit`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			if (requests === 1) {
				response.writeHead(statusCode, {'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT'}).end();
				return;
			}

			response.end('ok');
		});

		const response = await got('', {
			retry: {
				maxRetryAfter: 0,
				limit: 1,
				calculateDelay({retryAfter, computedValue}) {
					assert.strictEqual(retryAfter, 0);
					assert.strictEqual(computedValue, 1);
					return computedValue;
				},
			},
		});

		assert.strictEqual(response.body, 'ok');
		assert.strictEqual(requests, 2);
	});
}

for (const maxRetryAfter of [0, 999, 1000]) {
	test(`a one-second Retry-After respects maxRetryAfter ${maxRetryAfter}`, withServer, async (_t, server, got) => {
		let requests = 0;
		let delayCalls = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.writeHead(requests === 1 ? 429 : 200, {'retry-after': '1'}).end();
		});

		const response = await got('', {
			throwHttpErrors: false,
			retry: {
				maxRetryAfter,
				limit: 1,
				calculateDelay({retryAfter, computedValue}) {
					delayCalls++;
					assert.strictEqual(retryAfter, 1000);
					assert.strictEqual(computedValue, 1000);
					return 1;
				},
			},
		});

		const shouldRetry = maxRetryAfter === 1000;
		assert.strictEqual(response.statusCode, shouldRetry ? 200 : 429);
		assert.strictEqual(delayCalls, shouldRetry ? 1 : 0);
		assert.strictEqual(requests, shouldRetry ? 2 : 1);
	});
}

// Inspect the parsed delay without sleeping for the server's requested duration.
for (const {header, expectedDelay} of [
	{header: '0002', expectedDelay: 2000},
	{header: '\t 2 \t', expectedDelay: 2000},
	{header: '86400', expectedDelay: 86_400_000},
]) {
	test(`Retry-After parses delta-seconds ${JSON.stringify(header)} without changing its units`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(503, {'retry-after': header}).end();
		});
		let delayCalls = 0;
		const response = await got('', {
			throwHttpErrors: false,
			retry: {
				calculateDelay({retryAfter, computedValue, attemptCount}) {
					delayCalls++;
					assert.strictEqual(retryAfter, expectedDelay);
					assert.strictEqual(computedValue, expectedDelay);
					assert.strictEqual(attemptCount, 1);
					return 0;
				},
			},
		});

		assert.strictEqual(delayCalls, 1);
		assert.strictEqual(response.retryCount, 0);
	});
}

// RFC 9110 section 5.6.7 requires recipients to accept both obsolete HTTP-date formats.
for (const header of ['Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) {
	test(`Retry-After accepts obsolete HTTP-date ${header}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			response.writeHead(++requests === 1 ? 503 : 200, {'retry-after': header}).end();
		});
		let delayCalls = 0;
		const response = await got('', {
			retry: {
				limit: 1,
				maxRetryAfter: 0,
				calculateDelay({retryAfter, computedValue}) {
					delayCalls++;
					assert.strictEqual(retryAfter, 0);
					assert.strictEqual(computedValue, 1);
					return computedValue;
				},
			},
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(requests, 2);
		assert.strictEqual(delayCalls, 1);
	});
}

test('Retry-After HTTP-date exposes the remaining milliseconds to calculateDelay', withServer, async (_t, server, got) => {
	let sentAt = 0;
	let retryAt = 0;
	server.get('/', (_request, response) => {
		sentAt = Date.now();
		const date = new Date(sentAt + 60_000).toUTCString();
		retryAt = Date.parse(date);
		response.writeHead(503, {'retry-after': date}).end();
	});
	let delayCalls = 0;
	await got('', {
		throwHttpErrors: false,
		retry: {
			calculateDelay({retryAfter, computedValue}) {
				delayCalls++;
				const receivedAt = Date.now();
				assert.strictEqual(retryAfter! >= Math.max(0, retryAt - receivedAt), true);
				assert.strictEqual(retryAfter! <= retryAt - sentAt, true);
				assert.strictEqual(computedValue, Math.max(1, retryAfter!));
				return 0;
			},
		},
	});
	assert.strictEqual(delayCalls, 1);
});

for (const header of ['-1', '+1', '1e3']) {
	test(`Retry-After rejects signed or exponential delta-seconds ${header}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(503, {'retry-after': header}).end();
		});
		let delayCalls = 0;
		await got('', {
			throwHttpErrors: false,
			retry: {
				noise: 0,
				calculateDelay({retryAfter, computedValue}) {
					delayCalls++;
					assert.strictEqual(retryAfter, undefined);
					assert.strictEqual(computedValue, 1000);
					return 0;
				},
			},
		});
		assert.strictEqual(delayCalls, 1);
	});
}

for (const maxRetryAfter of [undefined, 60_000]) {
	test(`Retry-After uses ${maxRetryAfter === undefined ? 'the request timeout as its default cap' : 'an explicit cap instead of the request timeout'}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(503, {'retry-after': '60'}).end();
		});
		let delayCalls = 0;
		const response = await got('', {
			throwHttpErrors: false,
			timeout: {request: 30_000},
			retry: {
				maxRetryAfter,
				calculateDelay({retryAfter, computedValue}) {
					delayCalls++;
					assert.strictEqual(retryAfter, 60_000);
					assert.strictEqual(computedValue, 60_000);
					return 0;
				},
			},
		});

		assert.strictEqual(delayCalls, maxRetryAfter === undefined ? 0 : 1);
		assert.strictEqual(response.retryCount, 0);
		assert.strictEqual(response.statusCode, 503);
	});
}

for (const {format, timezone, dayOfMonth} of [
	{format: 'asctime', timezone: 'Etc/GMT-2', dayOfMonth: 6},
	{format: 'asctime', timezone: 'UTC', dayOfMonth: 6},
	{format: 'asctime', timezone: 'Etc/GMT+5', dayOfMonth: 17},
	{format: 'IMF-fixdate', timezone: 'Etc/GMT-2', dayOfMonth: 6},
	{format: 'RFC 850', timezone: 'Etc/GMT+5', dayOfMonth: 17},
]) {
	test.serial(`Retry-After interprets ${format} HTTP-date in UTC with timezone ${timezone}`, withServer, async (t, server, got) => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = timezone;
		t.after(() => {
			if (previousTimezone === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = previousTimezone;
			}
		});
		const now = new Date();
		const retryAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, dayOfMonth, 8, 49, 37);
		const date = new Date(retryAt);
		const [weekday, day, month, year, time] = date.toUTCString().split(' ', 5);
		let header = date.toUTCString();
		if (format === 'asctime') {
			header = `${weekday!.slice(0, -1)} ${month} ${String(Number(day)).padStart(2, ' ')} ${time} ${year}`;
		} else if (format === 'RFC 850') {
			const fullWeekday = date.toLocaleDateString('en-US', {weekday: 'long', timeZone: 'UTC'});
			header = `${fullWeekday}, ${day}-${month}-${year!.slice(-2)} ${time} GMT`;
		}

		let sentAt = 0;
		server.get('/', (_request, response) => {
			sentAt = Date.now();
			response.writeHead(503, {'retry-after': header}).end();
		});
		let delayCalls = 0;
		await got('', {
			throwHttpErrors: false,
			retry: {
				calculateDelay({retryAfter, computedValue}) {
					delayCalls++;
					const receivedAt = Date.now();
					assert.strictEqual(retryAfter! >= retryAt - receivedAt, true);
					assert.strictEqual(retryAfter! <= retryAt - sentAt, true);
					assert.strictEqual(computedValue, retryAfter!);
					return 0;
				},
			},
		});
		assert.strictEqual(delayCalls, 1);
	});
}

test('backoffLimit above 2_147_483_647 prevents overflowing setTimeout and stops retrying', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(503).end();
	});

	await assert.rejects(got('', {
		retry: {
			limit: 1,
			backoffLimit: 3_000_000_000,
			noise: 0,
			calculateDelay: ({retryOptions}) => retryOptions.backoffLimit,
		},
	}), HTTPError);

	assert.strictEqual(requests, 1);
});

type ReplacementCase = [string, () => {options: Record<string, unknown>; expected: string}];

const replacementCases: ReplacementCase[] = [
	['a string', () => ({options: {body: 'replacement'}, expected: 'replacement'})],
	['a Buffer', () => ({options: {body: Buffer.from('replacement')}, expected: 'replacement'})],
	['a Uint8Array view with a byte offset', () => {
		const bytes = new TextEncoder().encode('\u{0}\u{0}\u{0}replacement');
		return {options: {body: new Uint8Array(bytes.buffer, 3, 11)}, expected: 'replacement'};
	}],
	['a DataView with a byte offset', () => {
		const bytes = new TextEncoder().encode('\u{0}\u{0}\u{0}replacement');
		return {options: {body: new DataView(bytes.buffer, 3, 11)}, expected: 'replacement'};
	}],
	['json', () => ({options: {json: {replacement: true}}, expected: '{"replacement":true}'})],
	['form', () => ({options: {form: {replacement: 'true'}}, expected: 'replacement=true'})],
	['an array', () => ({options: {body: ['a', 'b', 'c']}, expected: 'abc'})],
	['a Set', () => ({options: {body: new Set(['a', 'b'])}, expected: 'ab'})],
	['a sync generator', () => ({
		options: {
			body: (function * () {
				yield 'replacement';
			})(),
		},
		expected: 'replacement',
	})],
	['an async generator', () => ({
		options: {
			body: (async function * () {
				yield 'replacement';
			})(),
		},
		expected: 'replacement',
	})],
	['an async iterable object', () => ({
		options: {
			body: {
				async * [Symbol.asyncIterator]() {
					yield 'replacement';
				},
			},
		},
		expected: 'replacement',
	})],
	['a Node stream', () => {
		const stream = new PassThroughStream();
		stream.end('replacement');
		return {options: {body: stream}, expected: 'replacement'};
	}],
	['a Web ReadableStream', () => ({
		options: {
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('replacement'));
					controller.close();
				},
			}),
		},
		expected: 'replacement',
	})],
];

for (const [name, create] of replacementCases) {
	test(`afterResponse retry sends ${name} as the replacement body`, withServer, async (_t, server, got) => {
		const received: string[] = [];
		server.post('/', async (request, response) => {
			received.push(await getStream(request));
			response.end('done');
		});

		const {options, expected} = create();
		const response = await got.post('', {
			body: 'original',
			retry: {limit: 0},
			hooks: {
				afterResponse: [
					(_response, retryWithMergedOptions) => retryWithMergedOptions(options),
				],
			},
		});

		assert.strictEqual(response.body, 'done');
		assert.deepStrictEqual(received, ['original', expected]);
	});
}

test('afterResponse retry sends a replacement FormData body', withServer, async (_t, server, got) => {
	const received: string[] = [];
	server.post('/', async (request, response) => {
		received.push(await getStream(request));
		response.end('done');
	});

	const response = await got.post('', {
		body: 'original',
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => {
					const form = new FormData();
					form.set('replacement', 'true');
					return retryWithMergedOptions({body: form});
				},
			],
		},
	});

	assert.strictEqual(response.body, 'done');
	assert.strictEqual(received.length, 2);
	assert.strictEqual(received[1]!.includes('name="replacement"'), true);
});

test('afterResponse retry tears down the consumed body after the replacement has been sent', withServer, async (_t, server, got) => {
	// `autoDestroy: false` keeps the stream alive after it ends, so only got can destroy it.
	const previous = new PassThroughStream({autoDestroy: false});
	previous.end('original');
	let previousDestroyed = false;
	previous.once('close', () => {
		previousDestroyed = true;
	});

	const received: string[] = [];
	server.post('/', async (request, response) => {
		received.push(await getStream(request));
		response.end('done');
	});

	const replacement = new PassThroughStream();
	replacement.end('replacement');

	await got.post('', {
		body: previous,
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({body: replacement}),
			],
		},
	});

	assert.deepStrictEqual(received, ['original', 'replacement']);
	assert.strictEqual(previousDestroyed, true);
});

type OneShotBody = Generator<string> | AsyncGenerator<string> | Readable | ReadableStream;

for (const [name, create] of [
	['a sync generator', () => (function * () {
		yield 'replacement';
	})()],
	['an async generator', () => (async function * () {
		yield 'replacement';
	})()],
	['a Node stream', () => {
		const stream = new PassThroughStream();
		stream.end('replacement');
		return stream;
	}],
	['a Web ReadableStream', () => new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('replacement'));
			controller.close();
		},
	})],
] as Array<[string, () => OneShotBody]>) {
	test(`afterResponse retry sends ${name} when the first attempt had no body`, withServer, async (_t, server, got) => {
		const received: string[] = [];
		server.post('/', async (request, response) => {
			received.push(await getStream(request));
			response.end('done');
		});

		const response = await got.post('', {
			retry: {limit: 0},
			hooks: {
				afterResponse: [
					(_response, retryWithMergedOptions) => retryWithMergedOptions({body: create()}),
				],
			},
		});

		assert.strictEqual(response.body, 'done');
		assert.deepStrictEqual(received, ['', 'replacement']);
	});
}

test('afterResponse retry with a generator body keeps same-origin headers', withServer, async (_t, server, got) => {
	const received: Array<{body: string; authorization: string | undefined; cookie: string | undefined}> = [];
	server.get('/', (_request, response) => {
		response.end('retry me');
	});
	server.post('/', async (request, response) => {
		received.push({
			body: await getStream(request),
			authorization: request.headers.authorization,
			cookie: request.headers.cookie,
		});
		response.end('done');
	});

	const response = await got.get('', {
		headers: {authorization: 'Bearer secret', cookie: 'session=secret'},
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					method: 'POST',
					body: (async function * () {
						yield 'same-origin';
					})(),
				}),
			],
		},
	});

	assert.strictEqual(response.body, 'done');
	assert.strictEqual(received[0]!.body, 'same-origin');
	assert.strictEqual(received[0]!.authorization, 'Bearer secret');
	assert.strictEqual(received[0]!.cookie, 'session=secret');
});

test('afterResponse can retry more than once, replacing the body each time', withServer, async (_t, server, got) => {
	const received: string[] = [];
	server.post('/', async (request, response) => {
		received.push(await getStream(request));
		response.end('done');
	});

	const response = await got.post('', {
		body: 'first',
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.request.retryCount < 2) {
						// `preserveHooks` keeps this hook for the next attempt, so the chain can continue.
						return retryWithMergedOptions({
							preserveHooks: true,
							body: (async function * () {
								yield `attempt-${response.request.retryCount + 1}`;
							})(),
						});
					}

					return response;
				},
			],
		},
	});

	assert.strictEqual(response.body, 'done');
	assert.deepStrictEqual(received, ['first', 'attempt-1', 'attempt-2']);
});

test('afterResponse retry honors a content-length set by the hook', withServer, async (_t, server, got) => {
	const received: Array<{body: string; length: string | undefined}> = [];
	server.post('/', async (request, response) => {
		received.push({body: await getStream(request), length: request.headers['content-length']});
		response.end('done');
	});

	await got.post('', {
		body: 'original',
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					body: 'exactly-9',
					headers: {'content-length': '9'},
				}),
			],
		},
	});

	assert.deepStrictEqual(received[1], {body: 'exactly-9', length: '9'});
});

test('a body installed for a retry that cannot happen is torn down', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(302, {location: '/next'}).end();
	});
	server.post('/next', (_request, response) => {
		response.end('next');
	});

	const installed = new PassThroughStream();
	let installedDestroyed = false;
	installed.once('close', () => {
		installedDestroyed = true;
	});

	await assert.rejects(got('', {
		method: 'POST',
		body: 'original',
		retry: {limit: 0},
		hooks: {
			beforeRedirect: [options => {
				options.body = installed;
			}],
			beforeRequest: [options => {
				if (options.url instanceof URL && options.url.pathname === '/next') {
					throw new Error('Injected failure');
				}
			}],
		},
	}), {message: 'Injected failure'});

	assert.strictEqual(installedDestroyed, true);
});

test('a body installed for a retry is torn down when the retry is refused', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		await getStream(request);
		response.end('done');
	});

	const installed = new PassThroughStream();
	let installedDestroyed = false;
	installed.once('close', () => {
		installedDestroyed = true;
	});

	// `calculateDelay` returning 0 aborts the retry, so the request fails and nothing sends this body.
	await assert.rejects(got.post('', {
		body: 'original',
		retry: {limit: 1, calculateDelay: () => 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({body: installed}),
			],
		},
	}), RequestError);

	assert.strictEqual(installedDestroyed, true);
});

test('a body is torn down exactly once per request', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		requests++;
		const received = await getStream(request);
		if (requests === 1) {
			response.statusCode = 500;
			response.end('again');
			return;
		}

		response.end(received);
	});

	let returnCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			return {done: true, value: undefined};
		},
		async return() {
			returnCalls++;
			return {done: true, value: undefined};
		},
	};

	const response = await got.post('', {
		body,
		retry: {limit: 1, methods: ['POST']},
		hooks: {
			beforeRetry: [({options}) => {
				// `error.options` is the request's Options, so a retry can swap the body.
				options.body = 'replacement';
			}],
		},
	});

	// The dispatched body is closed once by teardown, not once per code path.
	assert.strictEqual(response.body, 'replacement');
	assert.strictEqual(requests, 2);
	assert.strictEqual(returnCalls, 1);
});

// Nothing dispatched the body a hook installed, so `_destroy` and `_error` both think they own
// it unless only one of them does.
test('a body a hook installed and then failed is torn down once', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.end('ok');
	});

	let returnCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			return {done: true, value: undefined};
		},
		async return() {
			returnCalls++;
			return {done: true, value: undefined};
		},
	};

	await assert.rejects(got.post('', {
		retry: {limit: 0},
		hooks: {
			beforeRequest: [options => {
				options.body = body;
				throw new Error('hook boom');
			}],
		},
	}), {message: 'hook boom'});

	assert.strictEqual(returnCalls, 1);
});

// Every other listener invocation is guarded, so a throwing `retry` listener must not become
// an unhandled rejection.
test('a throwing retry listener is reported through the error path', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('fail');
	});

	const beforeErrorErrors: Error[] = [];
	const request = got.stream('', {
		retry: {
			limit: 3,
			calculateDelay: () => 1,
		},
		hooks: {
			beforeError: [error => {
				beforeErrorErrors.push(error);
				return error;
			}],
		},
	});

	request.on('retry', () => {
		throw new Error('listener boom');
	});

	// The request is destroyed before the listener runs, so the error reaches the caller
	// through the `beforeError` hook rather than the stream.
	await assert.rejects(getStream(request));
	assert.strictEqual(beforeErrorErrors.length, 1);
	assert.strictEqual(beforeErrorErrors[0]?.message, 'listener boom');
});
