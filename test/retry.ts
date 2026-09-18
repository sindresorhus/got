import {EventEmitter} from 'node:events';
import {PassThrough as PassThroughStream, Readable} from 'node:stream';
import type {Socket} from 'node:net';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import test from 'ava';
import is from '@sindresorhus/is';
import type {Handler} from 'express';
import getStream from 'get-stream';
import {pEvent} from 'p-event';
import got, {
	HTTPError, RequestError, TimeoutError, UploadError,
} from '../source/index.js';
import type Request from '../source/core/index.js';
import withServer from './helpers/with-server.js';

const retryAfterOn413 = 2;
const socketTimeout = 300;

test('Retry-After beyond the timer limit does not become an immediate retry', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		if (++requests === 1) {
			response.writeHead(503, {'retry-after': '2592000'}).end('try next month');
			return;
		}

		response.end('retried too early');
	});

	const error = await t.throwsAsync<HTTPError>(got('', {retry: {limit: 1}}), {instanceOf: HTTPError});
	t.is(error.response.statusCode, 503);
	t.is(error.response.body, 'try next month');
	t.is(requests, 1);
});

for (const retryAfter of ['2147484', '9999999999999999999999999999999999999999', 'Thu, 01 Jan 2099 00:00:00 GMT']) {
	test(`overflowing Retry-After ${retryAfter} preserves a non-throwing error response`, withServer, async (t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.writeHead(503, {'retry-after': retryAfter}).end('unavailable');
		});

		const response = await got('', {throwHttpErrors: false, retry: {limit: 1}});
		t.is(response.statusCode, 503);
		t.is(response.body, 'unavailable');
		t.is(response.retryCount, 0);
		t.is(requests, 1);
	});
}

for (const backoff of [2_147_483_648, Number.POSITIVE_INFINITY]) {
	test(`custom retry delay ${backoff} does not overflow`, withServer, async (t, server, got) => {
		let requests = 0;
		let retryHooks = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.writeHead(503).end();
		});

		await t.throwsAsync(got('', {
			retry: {limit: 1, calculateDelay: () => backoff},
			hooks: {
				beforeRetry: [() => {
					retryHooks++;
				}],
			},
		}), {instanceOf: HTTPError});
		t.is(requests, 1);
		t.is(retryHooks, 0);
	});
}

test('calculateDelay can scale an overflowing server delay down to a supported delay', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.writeHead(++requests === 1 ? 503 : 200, {'retry-after': '2592000'}).end('done');
	});

	const response = await got('', {
		retry: {
			limit: 1, calculateDelay({computedValue, retryAfter}) {
				t.is(computedValue, 2_592_000_000);
				t.is(retryAfter, computedValue);
				return 1;
			},
		},
	});
	t.is(response.body, 'done');
	t.is(response.retryCount, 1);
	t.is(requests, 2);
});

test('the maximum supported retry timer remains cancellable', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(503).end();
	});
	const controller = new AbortController();
	let calculated = false;

	await t.throwsAsync(got('', {
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
	t.true(calculated);
	t.is(requests, 1);
});

test('beforeRetry body replacement updates the generated content length', withServer, async (t, server, got) => {
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

	t.is(body, '3');
	t.is(requests, 2);
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
	test(`beforeRetry refreshes body framing for ${name}`, withServer, async (t, server, got) => {
		let requests = 0;
		server.put('/', async (request, response) => {
			const body = await getStream(request);
			if (++requests === 1) {
				t.is(body, 'original payload');
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

		t.is(result.body, expectedBody);
		t.is(result.contentLength, expectedLength);
		t.is(requests, 2);
	});
}

test('beforeRetry preserves explicitly reassigned content length for a stream', withServer, async (t, server, got) => {
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

	t.deepEqual(result, {body: 'replacement body', contentLength: '16'});
	t.is(requests, 2);
});

test('failure to reopen an iterable upload rejects the retried request', withServer, async (t, server, got) => {
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
	const error = await t.throwsAsync<UploadError>(got.put('', {
		body,
		retry: {limit: 1, backoffLimit: 0, noise: 0},
	}), {instanceOf: UploadError, message: cause.message});

	t.is(error.cause, cause);
	t.is(iterations, 2);
});

test('failure to reopen an async iterable upload rejects the retried request', withServer, async (t, server, got) => {
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
	const error = await t.throwsAsync<UploadError>(got.put('', {
		body,
		retry: {limit: 1, backoffLimit: 0, noise: 0},
	}), {instanceOf: UploadError, message: cause.message});

	t.is(error.cause, cause);
	t.is(iterations, 2);
});

for (const asynchronous of [false, true]) {
	test(`retries open reusable upload sources only when sending with async ${asynchronous}`, withServer, async (t, server, got) => {
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

		t.is(await got.put('', {body, retry: {limit: 1, backoffLimit: 0, noise: 0}}).text(), 'payload');
		t.is(iterations, 2);
		t.is(requests, 2);
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

test('works on timeout', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		response.end('who`s there?');
	});

	t.is((await got({
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
	let capturedAttemptCount: number | undefined;

	await t.throwsAsync(got('https://example.com', {
		timeout: {socket: socketTimeout},
		retry: {
			calculateDelay({attemptCount}) {
				capturedAttemptCount = attemptCount;
				return 0;
			},
		},
		request: () => createSocketTimeoutStream('https://example.com'),
	}), {
		instanceOf: TimeoutError,
		message: `Timeout awaiting 'socket' for ${socketTimeout}ms`,
	});

	t.is(capturedAttemptCount, 1);
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
	let capturedErrorCode: string | undefined;

	const error = await t.throwsAsync<Error & {code: typeof errorCode}>(got('https://example.com', {
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
			});

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

	t.is(capturedErrorCode, errorCode);
	t.is(error?.code, errorCode);
});

test('retries when ClientRequest emits a connection error before its end callback receives it', async t => {
	let attemptCount = 0;
	let beforeRetryCount = 0;
	let beforeErrorCount = 0;

	const error = await t.throwsAsync(got('http://localhost', {
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
				t.is(error.code, 'ECONNREFUSED');
			}],
			beforeError: [error => {
				beforeErrorCount++;
				return error;
			}],
		},
	}), {
		instanceOf: RequestError,
	});

	t.is(attemptCount, 3);
	t.is(beforeRetryCount, 2);
	t.is(beforeErrorCount, 1);
	t.is(error?.code, 'ECONNREFUSED');
	t.is(error?.request?.retryCount, 2);
});

test('recovers when retrying after a request end error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let attemptCount = 0;
	const response = await got({
		request(url, options) {
			attemptCount++;

			if (attemptCount === 1) {
				return createRequestWithEndError('end-callback-only');
			}

			return http.request(url, options);
		},
		retry: {
			limit: 1,
			backoffLimit: 1,
			noise: 0,
		},
	});

	t.is(response.body, 'ok');
	t.is(response.retryCount, 1);
	t.is(attemptCount, 2);
});

test('end callback errors do not finish the stream before retrying', async t => {
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

	await pEvent(stream, 'retry');

	t.is(finishCount, 0);
	t.false(stream.writableFinished);
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

for (const statusCode of [413, 429, 503]) {
	test(`retries immediately on ${statusCode} with Retry-After of 0`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, 0);
					t.is(computedValue, 1);
					return 1;
				},
			},
		});
		t.is(response.statusCode, 200);
		t.is(response.retryCount, 1);
	});
}

test('ignores an invalid Retry-After header', withServer, async (t, server, got) => {
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
				t.is(retryAfter, undefined);
				t.false(Number.isNaN(computedValue));
				return 1;
			},
		},
	});
	t.is(response.statusCode, 200);
	t.is(response.retryCount, 1);
});

for (const retryAfterHeader of ['Infinity', '0x10', '1.5', '']) {
	test(`ignores Retry-After with invalid numeric syntax: ${JSON.stringify(retryAfterHeader)}`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, undefined);
					return 1;
				},
			},
		});
		t.is(response.statusCode, 200);
		t.is(response.retryCount, 1);
	});
}

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

	let retried = false;

	await t.throwsAsync(got.post({
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
	}), {instanceOf: TimeoutError});

	t.false(retried, 'Retries on POST requests');
});

test('retries QUERY with JSON body by default', withServer, async (t, server, got) => {
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

	t.is(retryCount, 1);
	t.deepEqual(JSON.parse(body), payload);
	t.deepEqual(attempts, [
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

	await t.throwsAsync(got('redirect'), {message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/v});
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

	t.is(data, 'ok');
	t.is(globalRetryCount, 1);
});

test('can retry a Got stream with allowAbsoluteUrls false', withServer, async (t, server, got) => {
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

	t.is(data, 'ok');
});

test('`allowAbsoluteUrls: false` rejects an absolute URL passed to a Got stream retry', withServer, async (t, server, got) => {
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

	t.is(error.message, 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set');
});

test('throws when cannot retry a Got stream', withServer, async (t, server, got) => {
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

test('createRetryStream accepts options', withServer, async (t, server, got) => {
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

	t.is(data, 'ok');
	t.true(receivedCustomHeader);
});

test('createRetryStream re-copies piped headers on retry', withServer, async (t, server, got) => {
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

	t.is(headers['x-custom-header'], 'second-value');
});

test('createRetryStream preserves explicit header omissions after undefined header pruning', withServer, async (t, server, got) => {
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

	t.is(headers.authorization, undefined);
});

test('createRetryStream re-copies piped headers after internal header additions on previous attempt', withServer, async (t, server, got) => {
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

	t.is(headers['accept-encoding'], 'identity');
});

test('createRetryStream preserves header omission from direct header mutation', withServer, async (t, server, got) => {
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

	t.is(headers.authorization, undefined);
});

test('createRetryStream preserves mixed-case header omission from direct header mutation', withServer, async (t, server, got) => {
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

	t.is(headers.authorization, undefined);
});

test('createRetryStream keeps username/password authorization precedence over piped authorization', withServer, async (t, server, got) => {
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

	t.is(headers.authorization, 'Basic Zm9vOmJhcg==');
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

	t.is(retryCount, 2);
	t.is(requestCount, 3);
	t.deepEqual(computedValues, [10, 10]);
});

test('enforceRetryRules respects statusCodes with custom calculateDelay', withServer, async (t, server, got) => {
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
	t.is(statusCode, 500);
	t.is(retryCount, 0);
});

test('enforces retry rules by default with custom calculateDelay', withServer, async (t, server, got) => {
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

	t.is(statusCode, 500);
	t.is(retryCount, 0);
});

test('enforceRetryRules respects limit with custom calculateDelay', withServer, async (t, server, got) => {
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
	t.is(retryCount, 2);
	t.is(requestCount, 3); // Initial request + 2 retries
});

test('retries on stream errors like EPIPE when configured', async t => {
	let attemptCount = 0;
	let retryCount = 0;

	const error = await t.throwsAsync<Error & {code: string}>(got.post('https://example.com', {
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
	t.is(attemptCount, 3);
	t.is(retryCount, 2);
	t.is(error?.code, 'EPIPE');
});

test('does not retry on stream errors when not in errorCodes', async t => {
	let attemptCount = 0;

	const error = await t.throwsAsync<Error & {code: string}>(got('https://example.com', {
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
	t.is(attemptCount, 1);
	t.is(error?.code, 'ETEST');
});

test('does not retry after promise settles (issue #1489)', async t => {
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
			});

			return emitter;
		},
		throwHttpErrors: false,
	});

	t.is(response.statusCode, 200);
	t.false(retryTriggered);
});

test('does not retry with a consumed generator body', withServer, async (t, server, got) => {
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

	await t.throwsAsync(got.post({
		body: body(),
		retry: {
			limit: 1,
			methods: ['POST'],
			calculateDelay: () => 1,
		},
	}), {
		message: 'Cannot retry with consumed body stream',
	});

	t.deepEqual(bodies, ['part1part2']);
});

test('retries with a FormData body', withServer, async (t, server, got) => {
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

	t.is(bodies.length, 3);
	for (const body of bodies) {
		t.true(body.includes('value'));
	}
});

test('retries with a FormData body using content-type changed in beforeRetry hook', withServer, async (t, server, got) => {
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

	t.true(contentTypes[0]!.startsWith('multipart/form-data; boundary='));
	t.is(contentTypes[1], 'text/plain');
});

test('a zero backoff limit retries without disabling retry rules', withServer, async (t, server, got) => {
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

	t.is(response.body, 'ok');
	t.is(response.retryCount, 1);
	t.is(requests, 2);
});

test('zero backoff still stops at the retry limit', withServer, async (t, server, got) => {
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

	t.is(response.retryCount, 2);
	t.is(requests, 3);
});

test('a custom zero delay can disable a retry with zero backoff', withServer, async (t, server, got) => {
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

	t.is(response.retryCount, 0);
	t.is(requests, 1);
	t.deepEqual(delays, [1]);
});

for (const statusCode of [404, 413]) {
	test(`zero backoff does not make status ${statusCode} retryable`, withServer, async (t, server, got) => {
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

		t.is(response.retryCount, 0);
		t.is(requests, 1);
	});
}

test('negative retry noise cannot produce a nonpositive computed delay', withServer, async (t, server, got) => {
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

	t.is(requests, 2);
	t.deepEqual(delays, [1]);
});

test('requestUrl preserves the original URL when beforeRetry changes the destination', withServer, async (t, server, got) => {
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

	t.is(response.body, '/recovered?initial=yes');
	t.is(response.url, `${server.url}/recovered?initial=yes`);
	t.is(response.retryCount, 1);
	t.is(response.requestUrl.href, `${server.url}/original?initial=yes`);
});

test('a zero maxRetryAfter allows a server-requested immediate retry', withServer, async (t, server, got) => {
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

	t.is(response.body, 'ok');
	t.is(response.retryCount, 1);
	t.is(requests, 2);
});

test('requestUrl survives a redirect followed by a retry', withServer, async (t, server, got) => {
	let attempts = 0;
	server.get('/original', (_request, response) => {
		response.redirect('/destination');
	});
	server.get('/destination', (_request, response) => {
		response.statusCode = ++attempts === 1 ? 503 : 200;
		response.end('done');
	});

	const response = await got('original', {retry: {limit: 1, backoffLimit: 0, noise: 0}});

	t.is(response.body, 'done');
	t.is(attempts, 2);
	t.is(response.url, `${server.url}/destination`);
	t.is(response.requestUrl.href, `${server.url}/original`);
});

test('requestUrl survives an afterResponse retry to another path', withServer, async (t, server, got) => {
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

	t.is(response.body, 'recovered');
	t.is(response.retryCount, 1);
	t.is(response.url, `${server.url}/recovered`);
	t.is(response.requestUrl.href, `${server.url}/original`);
});

test('failed retries retain the original requestUrl across multiple destinations', withServer, async (t, server, got) => {
	const paths: string[] = [];
	server.get('/:attempt', (request, response) => {
		paths.push(request.path);
		response.statusCode = 503;
		response.end('unavailable');
	});

	const error = await t.throwsAsync<HTTPError>(got('0', {
		retry: {limit: 2, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [(error, retryCount) => {
				error.options.url = new URL(`/${retryCount}`, server.url);
			}],
		},
	}), {instanceOf: HTTPError});

	t.deepEqual(paths, ['/0', '/1', '/2']);
	t.is(error.response.url, `${server.url}/2`);
	t.is(error.response.requestUrl.href, `${server.url}/0`);
});

test('retry streams retain independent snapshots of the original requestUrl', withServer, async (t, server, got) => {
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

	t.is(await getStream(retried), 'recovered');
	t.is(retried.response?.url, `${server.url}/recovered`);
	t.is(retried.requestUrl?.href, `${server.url}/original`);
	t.not(retried.requestUrl, original.requestUrl);
	retried.requestUrl!.searchParams.set('later', 'change');
	t.is(original.requestUrl?.href, `${server.url}/original`);
});

for (const statusCode of [413, 503]) {
	test(`past Retry-After dates allow immediate ${statusCode} retries with a zero limit`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, 0);
					t.is(computedValue, 1);
					return computedValue;
				},
			},
		});

		t.is(response.body, 'ok');
		t.is(requests, 2);
	});
}

for (const maxRetryAfter of [0, 999, 1000]) {
	test(`a one-second Retry-After respects maxRetryAfter ${maxRetryAfter}`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, 1000);
					t.is(computedValue, 1000);
					return 1;
				},
			},
		});

		const shouldRetry = maxRetryAfter === 1000;
		t.is(response.statusCode, shouldRetry ? 200 : 429);
		t.is(delayCalls, shouldRetry ? 1 : 0);
		t.is(requests, shouldRetry ? 2 : 1);
	});
}

// Inspect the parsed delay without sleeping for the server's requested duration.
for (const {header, expectedDelay} of [
	{header: '0002', expectedDelay: 2000},
	{header: '\t 2 \t', expectedDelay: 2000},
	{header: '86400', expectedDelay: 86_400_000},
]) {
	test(`Retry-After parses delta-seconds ${JSON.stringify(header)} without changing its units`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(503, {'retry-after': header}).end();
		});
		let delayCalls = 0;
		const response = await got('', {
			throwHttpErrors: false,
			retry: {
				calculateDelay({retryAfter, computedValue, attemptCount}) {
					delayCalls++;
					t.is(retryAfter, expectedDelay);
					t.is(computedValue, expectedDelay);
					t.is(attemptCount, 1);
					return 0;
				},
			},
		});

		t.is(delayCalls, 1);
		t.is(response.retryCount, 0);
	});
}

// RFC 9110 section 5.6.7 requires recipients to accept both obsolete HTTP-date formats.
for (const header of ['Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) {
	test(`Retry-After accepts obsolete HTTP-date ${header}`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, 0);
					t.is(computedValue, 1);
					return computedValue;
				},
			},
		});

		t.is(response.statusCode, 200);
		t.is(requests, 2);
		t.is(delayCalls, 1);
	});
}

test('Retry-After HTTP-date exposes the remaining milliseconds to calculateDelay', withServer, async (t, server, got) => {
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
				t.true(retryAfter! >= Math.max(0, retryAt - receivedAt));
				t.true(retryAfter! <= retryAt - sentAt);
				t.is(computedValue, Math.max(1, retryAfter!));
				return 0;
			},
		},
	});
	t.is(delayCalls, 1);
});

for (const header of ['-1', '+1', '1e3']) {
	test(`Retry-After rejects signed or exponential delta-seconds ${header}`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, undefined);
					t.is(computedValue, 1000);
					return 0;
				},
			},
		});
		t.is(delayCalls, 1);
	});
}

for (const maxRetryAfter of [undefined, 60_000]) {
	test(`Retry-After uses ${maxRetryAfter === undefined ? 'the request timeout as its default cap' : 'an explicit cap instead of the request timeout'}`, withServer, async (t, server, got) => {
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
					t.is(retryAfter, 60_000);
					t.is(computedValue, 60_000);
					return 0;
				},
			},
		});

		t.is(delayCalls, maxRetryAfter === undefined ? 0 : 1);
		t.is(response.retryCount, 0);
		t.is(response.statusCode, 503);
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
		t.teardown(() => {
			if (previousTimezone === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = previousTimezone;
			}
		});
		const now = new Date();
		const retryAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, dayOfMonth, 8, 49, 37);
		const date = new Date(retryAt);
		const [weekday, day, month, year, time] = date.toUTCString().split(' ');
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
					t.true(retryAfter! >= retryAt - receivedAt);
					t.true(retryAfter! <= retryAt - sentAt);
					t.is(computedValue, retryAfter!);
					return 0;
				},
			},
		});
		t.is(delayCalls, 1);
	});
}

test('backoffLimit above 2_147_483_647 prevents overflowing setTimeout and stops retrying', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(503).end();
	});

	await t.throwsAsync(got('', {
		retry: {
			limit: 1,
			backoffLimit: 3_000_000_000,
			noise: 0,
			calculateDelay: ({retryOptions}) => retryOptions.backoffLimit,
		},
	}), {instanceOf: HTTPError});

	t.is(requests, 1);
});

test('Retry-After: 0 with zero backoff limit still triggers a retry', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		if (requests === 1) {
			response.writeHead(503, {'retry-after': '0'}).end();
			return;
		}

		response.end('ok');
	});

	const response = await got('', {retry: {limit: 1, backoffLimit: 0, noise: 0}});

	t.is(response.body, 'ok');
	t.is(response.retryCount, 1);
	t.is(requests, 2);
});
