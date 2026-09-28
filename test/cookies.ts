import http from 'node:http';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import * as toughCookie from 'tough-cookie';
import delay from 'delay';
import got, {RequestError, Options} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';

const createEvent = () => {
	let emit!: () => void;
	const emitted = new Promise<void>(resolve => {
		emit = resolve;
	});

	return {emit, emitted};
};

test('reads a cookie', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({cookieJar});

	const cookie = cookieJar.getCookiesSync(server.url)[0];
	assert.strictEqual(cookie?.key, 'hello');
	assert.strictEqual(cookie?.value, 'world');
});

test('reads multiple cookies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({cookieJar});

	const [cookieA, cookieB] = cookieJar.getCookiesSync(server.url);
	assert.strictEqual(cookieA!.key, 'hello');
	assert.strictEqual(cookieA!.value, 'world');
	assert.strictEqual(cookieB!.key, 'foo');
	assert.strictEqual(cookieB!.value, 'bar');
});

test('cookies doesn\'t break on redirects', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body, 'hello=world; foo=bar');
});

test('throws on invalid cookies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'invalid cookie; domain=localhost');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await assert.rejects(got({cookieJar}), errorMatching(RequestError, {message: 'Cookie failed to parse'}));
});

test('cookie jar errors preserve a response body that ends during the cookie write', withServer, async (_t, server, got) => {
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

	const error = await rejects(got({
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

	assert.strictEqual(error?.message, 'Cookie write failed');
	assert.strictEqual(error?.response?.body, expectedBody);
	assert.deepStrictEqual(error?.response?.rawBody, new TextEncoder().encode(expectedBody));
	assert.strictEqual(responseReadCount, 1);
});

test('cookie jar errors preserve a response body still being received during the cookie write', withServer, async (_t, server, got) => {
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

	const error = await rejects(got({
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

	assert.strictEqual(error?.message, 'Cookie write failed');
	assert.strictEqual(error?.response?.body, expectedBody);
	assert.deepStrictEqual(error?.response?.rawBody, new TextEncoder().encode(expectedBody));
});

test('async cookie writes consume the response body once', withServer, async (_t, server, got) => {
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
	assert.strictEqual(earlyResult, requestStillPending);

	assert.strictEqual(response.body, expectedBody);
	assert.deepStrictEqual(response.rawBody, new TextEncoder().encode(expectedBody));
	assert.strictEqual(responseReadCount, 1);
});

test('terminal redirects wait for async cookie writes', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.statusCode, 302);
	assert.strictEqual(response.body, expectedBody);
	assert.strictEqual(storedCookie, 'hello=world');
});

test('ignored cookie jar errors preserve a body received across the cookie write', withServer, async (_t, server, got) => {
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
	assert.strictEqual(response.body, expectedBody);
	assert.deepStrictEqual(response.rawBody, new TextEncoder().encode(expectedBody));
});

test('cookie jar errors preserve decompressed response bodies', withServer, async (_t, server, got) => {
	const expectedBody = 'compressed response body'.repeat(100);
	const clientResponseEnded = createEvent();

	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.setHeader('set-cookie', 'hello=world');
		response.end(gzipSync(expectedBody));
	});

	const error = await rejects(got({
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

	assert.strictEqual(error?.response?.body, expectedBody);
	assert.deepStrictEqual(error?.response?.rawBody, new TextEncoder().encode(expectedBody));
});

test('cookie jar errors respect the configured response encoding', withServer, async (_t, server, got) => {
	const expectedRawBody = new Uint8Array([0x48, 0xE9]);
	const clientResponseEnded = createEvent();

	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end(expectedRawBody);
	});

	const error = await rejects(got({
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

	assert.strictEqual(error?.response?.body, 'Hé');
	assert.deepStrictEqual(error?.response?.rawBody, expectedRawBody);
});

test('cookie jar errors preserve empty response bodies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const error = await rejects(got({
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {
				throw new Error('Cookie write failed');
			},
		},
	}));

	assert.strictEqual(error?.response?.body, '');
	assert.deepStrictEqual(error?.response?.rawBody, new Uint8Array());
});

test('beforeError hooks receive a complete multibyte response body after a cookie jar error', withServer, async (_t, server, got) => {
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

	const errorPromise = rejects(got({
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
				assert.strictEqual(error.response?.body, '€');
				assert.deepStrictEqual(error.response?.rawBody, expectedRawBody);
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

	assert.strictEqual(hookCallCountBeforeBodyCaptureFinished, 0);
	assert.strictEqual(hookCallCount, 1);
	assert.strictEqual(responseReadCount, 1);
	assert.strictEqual(error?.response?.body, '€');
	assert.deepStrictEqual(error?.response?.rawBody, expectedRawBody);
});

test('cookie response body capture is isolated between retry attempts', withServer, async (_t, server, got) => {
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
				assert.strictEqual(error.response?.body, 'body 1');
				assert.deepStrictEqual(error.response?.rawBody, new TextEncoder().encode('body 1'));
			}],
		},
	});

	assert.strictEqual(response.body, 'body 2');
	assert.strictEqual(requestCount, 2);
	assert.strictEqual(cookieWriteCount, 2);
	assert.strictEqual(beforeRetryCallCount, 1);
});

test('does not throw on invalid cookies when options.ignoreInvalidCookies is set', withServer, async (_t, server, got) => {
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
	assert.strictEqual(cookies.length, 0);
});

test('catches store errors', async _t => {
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

	await assert.rejects(got('https://example.com', {cookieJar}), errorMatching(RequestError, {message: error}));
});

test('overrides options.headers.cookie', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body, 'hello=world; foo=bar');
});

test('no unhandled errors', async _t => {
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

	await assert.rejects(got(`http://127.0.0.1:${port}`, options), errorMatching(RequestError, {message}));
	await delay(500);

	await close();
});

test('asynchronous cookie jars apply Set-Cookie fields in response order', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/target', 'set-cookie': ['session=old', 'session=new']}).end();
	});
	server.get('/target', (request, response) => {
		response.end(request.headers.cookie);
	});
	let cookie = '';
	const cookieJar = {
		async getCookieString() {
			return cookie;
		},
		async setCookie(value: string) {
			if (value === 'session=old') {
				await new Promise<void>(resolve => {
					setImmediate(resolve);
				});
			}

			cookie = value;
		},
	};

	assert.strictEqual(await got('', {cookieJar}).text(), 'session=new');
	assert.strictEqual(cookie, 'session=new');
});

for (const {cookies, expected} of [
	{cookies: ['session=old; Max-Age=0', 'session=new'], expected: 'session=new'},
	{cookies: ['session=new', 'session=old; Max-Age=0'], expected: ''},
	{cookies: ['first=one', 'second=two'], expected: 'first=one; second=two'},
]) {
	test(`async cookie storage preserves order for ${cookies.join(' then ')}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(200, {'set-cookie': cookies}).end('body');
		});
		const jar = new toughCookie.CookieJar();
		const operations: string[] = [];
		const cookieJar = {
			async getCookieString(url: string) {
				return jar.getCookieString(url);
			},
			async setCookie(value: string, url: string) {
				if (value === cookies[0]) {
					await new Promise<void>(resolve => {
						setImmediate(resolve);
					});
				}

				await jar.setCookie(value, url);
				operations.push(value);
			},
		};

		assert.strictEqual(await got('', {cookieJar}).text(), 'body');
		assert.strictEqual(await jar.getCookieString(server.url), expected);
		assert.deepStrictEqual(operations, cookies);
	});
}

test('ignored invalid cookies do not skip later ordered cookie writes', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {'set-cookie': ['first=one', 'invalid', 'last=two']}).end('body');
	});
	const jar = new toughCookie.CookieJar();
	const processed: string[] = [];
	const cookieJar = {
		async getCookieString(url: string) {
			return jar.getCookieString(url);
		},
		async setCookie(value: string, url: string) {
			processed.push(value);
			await jar.setCookie(value, url);
		},
	};

	assert.strictEqual(await got('', {cookieJar, ignoreInvalidCookies: true}).text(), 'body');
	assert.deepStrictEqual(processed, ['first=one', 'invalid', 'last=two']);
	assert.strictEqual(await jar.getCookieString(server.url), 'first=one; last=two');
});

test('accepts custom `cookieJar` object', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('set-cookie', ['hello=world']);
		response.end(request.headers.cookie);
	});

	const cookies: Record<string, string> = {};
	const cookieJar = {
		async getCookieString(url: string) {
			assert.strictEqual(typeof url, 'string');
			return cookies[url] ?? '';
		},

		async setCookie(rawCookie: string, url: string) {
			cookies[url] = rawCookie;
		},
	};

	const first = await got('', {cookieJar});
	const second = await got('', {cookieJar});

	assert.strictEqual(first.body, '');
	assert.strictEqual(second.body, 'hello=world');
});

test('throws on invalid `options.cookieJar.setCookie`', async _t => {
	await assert.rejects(got('https://example.com', {
		cookieJar: {
			// @ts-expect-error Error tests
			setCookie: 123,
		},
	}), errorMatching(RequestError, {message: 'Expected value which is `Function`, received value of type `number`.'}));
});

test('throws on invalid `options.cookieJar.getCookieString`', async _t => {
	await assert.rejects(got('https://example.com', {
		cookieJar: {
			async setCookie() {},
			// @ts-expect-error Error tests
			getCookieString: 123,
		},
	}), errorMatching(RequestError, {message: 'Expected value which is `Function`, received value of type `number`.'}));
});

test('cookies are cleared when redirecting to a different hostname (no cookieJar)', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
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
		assert.strictEqual(headers.cookie, undefined);
		assert.strictEqual(headers['user-agent'], 'custom');
	});
});

test('a request can disable cookies without creating a child instance', withServer, async (_t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new toughCookie.CookieJar();
	cookieJar.setCookieSync('session=value', server.url);
	const instance = client.extend({cookieJar});

	assert.strictEqual(await instance('', {cookieJar: undefined}).text(), 'no-cookie');
});

test('resetting the jar preserves an explicit Cookie header', withServer, async (_t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new toughCookie.CookieJar();
	cookieJar.setCookieSync('session=jar', server.url);
	const instance = client.extend({cookieJar});

	assert.strictEqual(await instance('', {cookieJar: undefined, headers: {cookie: 'session=explicit'}}).text(), 'session=explicit');
});

test('direct merge resets an already normalized cookie jar', _t => {
	const options = new Options('https://example.com/', {cookieJar: new toughCookie.CookieJar()});
	options.merge({cookieJar: undefined});

	assert.strictEqual(options.cookieJar, undefined);
	assert.strictEqual(options.url?.toString(), 'https://example.com/');
});

test('omitting cookieJar from request options preserves inherited cookies', withServer, async (_t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new toughCookie.CookieJar();
	cookieJar.setCookieSync('session=value', server.url);
	const instance = client.extend({cookieJar});

	assert.strictEqual(await instance('', {headers: {'x-test': 'unrelated'}}).text(), 'session=value');
});

test('a cookie jar reset survives replay when merging an instance', _t => {
	const instance = got.extend({cookieJar: new toughCookie.CookieJar()}).extend({cookieJar: undefined});
	const replayed = got.extend(instance, {headers: {'x-test': 'unrelated'}});

	assert.strictEqual(replayed.defaults.options.cookieJar, undefined);
});

test('a replacement jar works after a reset', withServer, async (_t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const originalJar = new toughCookie.CookieJar();
	originalJar.setCookieSync('session=original', server.url);
	const replacementJar = new toughCookie.CookieJar();
	replacementJar.setCookieSync('session=replacement', server.url);
	const instance = client.extend({cookieJar: originalJar}).extend({cookieJar: undefined});

	assert.strictEqual(await instance('', {cookieJar: replacementJar}).text(), 'session=replacement');
	assert.strictEqual(instance.defaults.options.cookieJar, undefined);
});

test('a per-request reset does not disable cookies for later requests', withServer, async (_t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new toughCookie.CookieJar();
	cookieJar.setCookieSync('session=value', server.url);
	const instance = client.extend({cookieJar});

	await instance('', {cookieJar: undefined});
	assert.strictEqual(instance.defaults.options.cookieJar, cookieJar);
	assert.strictEqual(await instance('').text(), 'session=value');
});

test('a per-request reset does not store response cookies in the inherited jar', withServer, async (_t, server, client) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'session=replaced; Path=/');
		response.end('ok');
	});

	const cookieJar = new toughCookie.CookieJar();
	cookieJar.setCookieSync('session=original; Path=/', server.url);
	const instance = client.extend({cookieJar});

	assert.strictEqual(await instance('', {cookieJar: undefined}).text(), 'ok');
	assert.strictEqual(cookieJar.getCookieStringSync(server.url), 'session=original');
});

test('a reset jar ignores invalid response cookies', withServer, async (_t, server, client) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'invalid cookie; domain=localhost');
		response.end('ok');
	});

	const instance = client.extend({cookieJar: new toughCookie.CookieJar()});

	assert.strictEqual(await instance('', {cookieJar: undefined}).text(), 'ok');
});

test('an init hook can supply an explicit cookie jar reset', _t => {
	const defaults = new Options({cookieJar: new toughCookie.CookieJar()});
	const options = new Options('https://example.com/', {
		hooks: {
			init: [plainOptions => {
				plainOptions.cookieJar = undefined;
			}],
		},
	}, defaults);

	assert.strictEqual(options.cookieJar, undefined);
});

test('explicit undefined resets an inherited cookie jar', _t => {
	const cookieJar = new toughCookie.CookieJar();
	const defaults = new Options({cookieJar});
	const options = new Options('https://example.com/', {cookieJar: undefined}, defaults);

	assert.strictEqual(options.cookieJar, undefined);
	assert.strictEqual(defaults.cookieJar, cookieJar);
});

test('extending an instance can reset its cookie jar', _t => {
	const cookieJar = new toughCookie.CookieJar();
	const parent = got.extend({cookieJar});
	const child = parent.extend({cookieJar: undefined});

	assert.strictEqual(child.defaults.options.cookieJar, undefined);
	assert.strictEqual(parent.defaults.options.cookieJar, cookieJar);
});

test('resetting the cookie jar removes cookies from subsequent requests', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('set-cookie', 'session=value; Path=/');
		response.end(request.headers.cookie ?? 'no-cookie');
	});
	server.get('/child', (request, response) => {
		response.setHeader('set-cookie', 'child=value; Path=/');
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new toughCookie.CookieJar();
	const instance = got.extend({cookieJar});

	assert.strictEqual(await instance('').text(), 'no-cookie');
	assert.strictEqual(await instance('').text(), 'session=value');

	// The parent still uses the jar.
	assert.strictEqual(await instance('').text(), 'session=value');

	const child = instance.extend({cookieJar: undefined});
	assert.strictEqual(await child('child').text(), 'no-cookie');
	// The child stores nothing in the parent jar.
	assert.deepStrictEqual(cookieJar.getCookiesSync(server.url).map(cookie => cookie.cookieString()), ['session=value']);
	assert.strictEqual(await child('child').text(), 'no-cookie');
	assert.deepStrictEqual(cookieJar.getCookiesSync(server.url).map(cookie => cookie.cookieString()), ['session=value']);
});

test('retry does not resend a cookie expired by the previous response', withServer, async (_t, server, got) => {
	const cookieJar = new toughCookie.CookieJar();
	await cookieJar.setCookie('session=old; Path=/', server.url);
	const cookies: Array<string | undefined> = [];
	server.get('/', (request, response) => {
		cookies.push(request.headers.cookie);
		if (cookies.length === 1) {
			response.writeHead(503, {'set-cookie': 'session=deleted; Max-Age=0; Path=/'}).end();
			return;
		}

		response.end('done');
	});

	await got('', {cookieJar, retry: {limit: 1, backoffLimit: 0, noise: 0}});

	assert.deepStrictEqual(cookies, ['session=old', undefined]);
});

for (const statusCode of [302, 307]) {
	test(`a ${statusCode} redirect does not resend a cookie expired by the previous response`, withServer, async (_t, server, got) => {
		const cookieJar = new toughCookie.CookieJar();
		await cookieJar.setCookie('session=old; Path=/', server.url);
		const cookies: Array<string | undefined> = [];
		server.use((request, response) => {
			cookies.push(request.headers.cookie);
			if (cookies.length === 1) {
				response.writeHead(statusCode, {location: '/next', 'set-cookie': 'session=deleted; Max-Age=0; Path=/'}).end();
				return;
			}

			response.end('done');
		});

		await got('', {cookieJar});

		assert.deepStrictEqual(cookies, ['session=old', undefined]);
	});
}

for (const cookie of ['explicit=value', '', undefined]) {
	test(`an empty cookie jar preserves an explicit Cookie value of ${JSON.stringify(cookie)}`, withServer, async (_t, server, got) => {
		const cookies: Array<string | undefined> = [];
		server.get('/', (request, response) => {
			cookies.push(request.headers.cookie);
			response.writeHead(cookies.length === 1 ? 503 : 200).end('done');
		});

		await got('', {
			cookieJar: new toughCookie.CookieJar(),
			headers: {cookie},
			retry: {limit: 1, backoffLimit: 0, noise: 0},
		});

		assert.deepStrictEqual(cookies, [cookie, cookie]);
	});
}
