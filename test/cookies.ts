import http from 'node:http';
import {gzipSync} from 'node:zlib';
import test from 'ava';
import * as toughCookie from 'tough-cookie';
import delay from 'delay';
import got, {RequestError} from '../source/index.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';

const createEvent = () => {
	let emit!: () => void;
	const emitted = new Promise<void>(resolve => {
		emit = resolve;
	});

	return {emit, emitted};
};

test('reads a cookie', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({cookieJar});

	const cookie = cookieJar.getCookiesSync(server.url)[0];
	t.is(cookie?.key, 'hello');
	t.is(cookie?.value, 'world');
});

test('reads multiple cookies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({cookieJar});

	const [cookieA, cookieB] = cookieJar.getCookiesSync(server.url);
	t.is(cookieA!.key, 'hello');
	t.is(cookieA!.value, 'world');
	t.is(cookieB!.key, 'foo');
	t.is(cookieB!.value, 'bar');
});

test('cookies doesn\'t break on redirects', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.setHeader('location', '/');
		response.statusCode = 302;
		response.end();
	});

	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? '');
	});

	const cookieJar = new toughCookie.CookieJar();

	const {body} = await got('redirect', {cookieJar});
	t.is(body, 'hello=world; foo=bar');
});

test('throws on invalid cookies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'invalid cookie; domain=localhost');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await t.throwsAsync(got({cookieJar}), {
		instanceOf: RequestError,
		message: 'Cookie failed to parse',
	});
});

test('cookie jar errors preserve a response body that ends during the cookie write', withServer, async (t, server, got) => {
	const expectedBody = 'response body'.repeat(10_000);
	const cookieWriteStarted = createEvent();
	const clientResponseEnded = createEvent();
	let responseReadCount = 0;

	server.get('/', async (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.flushHeaders();
		await cookieWriteStarted.emitted;
		response.end(expectedBody);
	});

	const error = await t.throwsAsync<RequestError>(got({
		request(url, options, callback) {
			return http.request(url, options, response => {
				response.once('end', clientResponseEnded.emit);
				const toArray = response.toArray.bind(response);
				response.toArray = async () => {
					responseReadCount++;
					return toArray();
				};

				callback?.(response);
			});
		},
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				cookieWriteStarted.emit();
				await clientResponseEnded.emitted;
				throw new Error('Cookie write failed');
			},
		},
	}));

	t.is(error?.message, 'Cookie write failed');
	t.is(error?.response?.body, expectedBody);
	t.deepEqual(error?.response?.rawBody, new TextEncoder().encode(expectedBody));
	t.is(responseReadCount, 1);
});

test('cookie jar errors preserve a response body still being received during the cookie write', withServer, async (t, server, got) => {
	const firstChunk = 'first chunk';
	const secondChunk = 'second chunk'.repeat(10_000);
	const cookieWriteStarted = createEvent();
	const cookieWriteFailed = createEvent();
	const cookieWriteFailureObserved = createEvent();

	server.get('/', async (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.flushHeaders();
		await cookieWriteStarted.emitted;
		await new Promise<void>((resolve, reject) => {
			response.write(firstChunk, error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
		cookieWriteFailed.emit();
		await cookieWriteFailureObserved.emitted;
		response.end(secondChunk);
	});

	const error = await t.throwsAsync<RequestError>(got({
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				cookieWriteStarted.emit();
				await cookieWriteFailed.emitted;
				cookieWriteFailureObserved.emit();
				throw new Error('Cookie write failed');
			},
		},
	}));
	const expectedBody = firstChunk + secondChunk;

	t.is(error?.message, 'Cookie write failed');
	t.is(error?.response?.body, expectedBody);
	t.deepEqual(error?.response?.rawBody, new TextEncoder().encode(expectedBody));
});

test('async cookie writes consume the response body once', withServer, async (t, server, got) => {
	const expectedBody = 'response body';
	const clientResponseEnded = createEvent();
	const cookieWriteMayFinish = createEvent();
	let responseReadCount = 0;

	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end(expectedBody);
	});

	const requestPromise = got({
		request(url, options, callback) {
			return http.request(url, options, response => {
				response.once('end', clientResponseEnded.emit);
				const toArray = response.toArray.bind(response);
				response.toArray = async () => {
					responseReadCount++;
					return toArray();
				};

				callback?.(response);
			});
		},
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				await clientResponseEnded.emitted;
				await cookieWriteMayFinish.emitted;
			},
		},
		timeout: {request: 5000},
	});
	await clientResponseEnded.emitted;
	const requestStillPending = Symbol('requestStillPending');
	const earlyResult = await Promise.race([
		requestPromise,
		new Promise<typeof requestStillPending>(resolve => {
			setImmediate(() => {
				resolve(requestStillPending);
			});
		}),
	]);
	cookieWriteMayFinish.emit();
	const response = await requestPromise;
	t.is(earlyResult, requestStillPending);

	t.is(response.body, expectedBody);
	t.deepEqual(response.rawBody, new TextEncoder().encode(expectedBody));
	t.is(responseReadCount, 1);
});

test('terminal redirects wait for async cookie writes', withServer, async (t, server, got) => {
	const expectedBody = 'redirect response body';
	const clientResponseEnded = createEvent();
	let storedCookie: string | undefined;

	server.get('/', (_request, response) => {
		response.statusCode = 302;
		response.setHeader('location', '/not-followed');
		response.setHeader('set-cookie', 'hello=world');
		response.end(expectedBody);
	});

	const response = await got({
		followRedirect: false,
		request(url, options, callback) {
			return http.request(url, options, response => {
				response.once('end', clientResponseEnded.emit);
				callback?.(response);
			});
		},
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie(rawCookie: string) {
				await clientResponseEnded.emitted;
				storedCookie = rawCookie;
			},
		},
		retry: {limit: 0},
		timeout: {request: 5000},
	});

	t.is(response.statusCode, 302);
	t.is(response.body, expectedBody);
	t.is(storedCookie, 'hello=world');
});

test('ignored cookie jar errors preserve a body received across the cookie write', withServer, async (t, server, got) => {
	const firstChunk = 'first chunk';
	const secondChunk = 'second chunk';
	const cookieWriteStarted = createEvent();
	const cookieWriteMayFail = createEvent();
	const cookieWriteFailed = createEvent();

	server.get('/', async (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.flushHeaders();
		await cookieWriteStarted.emitted;
		response.write(firstChunk);
		cookieWriteMayFail.emit();
		await cookieWriteFailed.emitted;
		response.end(secondChunk);
	});

	const response = await got({
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				cookieWriteStarted.emit();
				await cookieWriteMayFail.emitted;
				cookieWriteFailed.emit();
				throw new Error('Cookie write failed');
			},
		},
		ignoreInvalidCookies: true,
	});

	const expectedBody = firstChunk + secondChunk;
	t.is(response.body, expectedBody);
	t.deepEqual(response.rawBody, new TextEncoder().encode(expectedBody));
});

test('cookie jar errors preserve decompressed response bodies', withServer, async (t, server, got) => {
	const expectedBody = 'compressed response body'.repeat(100);
	const clientResponseEnded = createEvent();

	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.setHeader('set-cookie', 'hello=world');
		response.end(gzipSync(expectedBody));
	});

	const error = await t.throwsAsync<RequestError>(got({
		request(url, options, callback) {
			return http.request(url, options, response => {
				response.once('end', clientResponseEnded.emit);
				callback?.(response);
			});
		},
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				await clientResponseEnded.emitted;
				throw new Error('Cookie write failed');
			},
		},
	}));

	t.is(error?.response?.body, expectedBody);
	t.deepEqual(error?.response?.rawBody, new TextEncoder().encode(expectedBody));
});

test('cookie jar errors respect the configured response encoding', withServer, async (t, server, got) => {
	const expectedRawBody = new Uint8Array([0x48, 0xE9]);
	const clientResponseEnded = createEvent();

	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end(expectedRawBody);
	});

	const error = await t.throwsAsync<RequestError>(got({
		encoding: 'latin1',
		request(url, options, callback) {
			return http.request(url, options, response => {
				response.once('end', clientResponseEnded.emit);
				callback?.(response);
			});
		},
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				await clientResponseEnded.emitted;
				throw new Error('Cookie write failed');
			},
		},
	}));

	t.is(error?.response?.body, 'Hé');
	t.deepEqual(error?.response?.rawBody, expectedRawBody);
});

test('cookie jar errors preserve empty response bodies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const error = await t.throwsAsync<RequestError>(got({
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				throw new Error('Cookie write failed');
			},
		},
	}));

	t.is(error?.response?.body, '');
	t.deepEqual(error?.response?.rawBody, new Uint8Array());
});

test('beforeError hooks receive a complete multibyte response body after a cookie jar error', withServer, async (t, server, got) => {
	const firstChunk = new Uint8Array([0xE2]);
	const secondChunk = new Uint8Array([0x82, 0xAC]);
	const bodyBytesRead = createEvent();
	const bodyCaptureMayFinish = createEvent();
	const cookieWriteFailed = createEvent();
	const expectedRawBody = new Uint8Array([...firstChunk, ...secondChunk]);
	let responseReadCount = 0;
	let hookCallCount = 0;

	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.write(firstChunk);
		response.end(secondChunk);
	});

	const errorPromise = t.throwsAsync<RequestError>(got({
		request(url, options, callback) {
			return http.request(url, options, response => {
				const toArray = response.toArray.bind(response);
				response.toArray = async () => {
					responseReadCount++;
					const chunks = await toArray();
					bodyBytesRead.emit();
					await bodyCaptureMayFinish.emitted;
					return chunks;
				};

				callback?.(response);
			});
		},
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				await bodyBytesRead.emitted;
				cookieWriteFailed.emit();
				throw new Error('Cookie write failed');
			},
		},
		hooks: {
			beforeError: [error => {
				hookCallCount++;
				t.is(error.response?.body, '€');
				t.deepEqual(error.response?.rawBody, expectedRawBody);
				return error;
			}],
		},
	}));
	await cookieWriteFailed.emitted;
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	const hookCallCountBeforeBodyCaptureFinished = hookCallCount;
	bodyCaptureMayFinish.emit();
	const error = await errorPromise;

	t.is(hookCallCountBeforeBodyCaptureFinished, 0);
	t.is(hookCallCount, 1);
	t.is(responseReadCount, 1);
	t.is(error?.response?.body, '€');
	t.deepEqual(error?.response?.rawBody, expectedRawBody);
});

test('cookie response body capture is isolated between retry attempts', withServer, async (t, server, got) => {
	let requestCount = 0;
	let cookieWriteCount = 0;
	let beforeRetryCallCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		response.setHeader('set-cookie', `attempt=${requestCount}`);
		response.end(`body ${requestCount}`);
	});

	const response = await got({
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				cookieWriteCount++;
				if (cookieWriteCount === 1) {
					throw new Error('Cookie write failed');
				}
			},
		},
		retry: {
			limit: 1,
			enforceRetryRules: false,
			calculateDelay({attemptCount}) {
				return attemptCount === 1 ? 1 : 0;
			},
		},
		hooks: {
			beforeRetry: [error => {
				beforeRetryCallCount++;
				t.is(error.response?.body, 'body 1');
				t.deepEqual(error.response?.rawBody, new TextEncoder().encode('body 1'));
			}],
		},
	});

	t.is(response.body, 'body 2');
	t.is(requestCount, 2);
	t.is(cookieWriteCount, 2);
	t.is(beforeRetryCallCount, 1);
});

test('does not throw on invalid cookies when options.ignoreInvalidCookies is set', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'invalid cookie; domain=localhost');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({
		cookieJar,
		ignoreInvalidCookies: true,
	});

	const cookies = cookieJar.getCookiesSync(server.url);
	t.is(cookies.length, 0);
});

test('catches store errors', async t => {
	const error = 'Some error';
	const cookieJar = new toughCookie.CookieJar({
		findCookies(_domain: any, _path: any, _allowSpecialUseDomain: any, callback: any) {
			callback(new Error(error), []);
		},
		findCookie() {},
		getAllCookies() {},
		putCookie() {},
		removeCookies() {},
		removeCookie() {},
		updateCookie() {},
		synchronous: false,
	} as any);

	await t.throwsAsync(got('https://example.com', {cookieJar}), {
		instanceOf: RequestError,
		message: error,
	});
});

test('overrides options.headers.cookie', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.setHeader('location', '/');
		response.statusCode = 302;
		response.end();
	});

	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? '');
	});

	const cookieJar = new toughCookie.CookieJar();
	const {body} = await got('redirect', {
		cookieJar,
		headers: {
			cookie: 'a=b',
		},
	});
	t.is(body, 'hello=world; foo=bar');
});

test('no unhandled errors', async t => {
	const {port, close} = await createRawHttpServer(connection => {
		connection.end('blah');
	});

	const message = 'snap!';

	const options = {
		cookieJar: {
			async setCookie(_rawCookie: string, _url: string) {},
			async getCookieString(_url: string) {
				throw new Error(message);
			},
		},
	};

	await t.throwsAsync(got(`http://127.0.0.1:${port}`, options), {
		instanceOf: RequestError,
		message,
	});
	await delay(500);

	await close();
});

test('accepts custom `cookieJar` object', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('set-cookie', ['hello=world']);
		response.end(request.headers.cookie);
	});

	const cookies: Record<string, string> = {};
	const cookieJar = {
		async getCookieString(url: string) {
			t.is(typeof url, 'string');
			return cookies[url] ?? '';
		},

		async setCookie(rawCookie: string, url: string) {
			cookies[url] = rawCookie;
		},
	};

	const first = await got('', {cookieJar});
	const second = await got('', {cookieJar});

	t.is(first.body, '');
	t.is(second.body, 'hello=world');
});

test('throws on invalid `options.cookieJar.setCookie`', async t => {
	await t.throwsAsync(got('https://example.com', {
		cookieJar: {
			// @ts-expect-error Error tests
			setCookie: 123,
		},
	}), {
		instanceOf: RequestError,
		message: 'Expected value which is `Function`, received value of type `number`.',
	});
});

test('throws on invalid `options.cookieJar.getCookieString`', async t => {
	await t.throwsAsync(got('https://example.com', {
		cookieJar: {
			async setCookie() {},
			// @ts-expect-error Error tests
			getCookieString: 123,
		},
	}), {
		instanceOf: RequestError,
		message: 'Expected value which is `Function`, received value of type `number`.',
	});
});

test('cookies are cleared when redirecting to a different hostname (no cookieJar)', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				cookie: 'foo=bar',
				'user-agent': 'custom',
			},
		}).json<{headers: Record<string, string | undefined>}>();
		t.is(headers.cookie, undefined);
		t.is(headers['user-agent'], 'custom');
	});
});
