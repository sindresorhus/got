import {Buffer} from 'node:buffer';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {Agent, request as httpRequest, type ClientRequest} from 'node:http';
import type {LookupFunction} from 'node:net';
import {gzip} from 'node:zlib';
import process from 'node:process';
import {setImmediate} from 'node:timers/promises';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import type {Handler} from 'express';
import delay from 'delay';
import got, {CacheError, HTTPError, type Response} from '../source/index.js';
import {auto as autoHttp2Request} from '../source/core/utils/http2-client.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import {onceValue} from './helpers/once-value.js';
import test from './helpers/test.js';
import withServer, {withSocketServer} from './helpers/with-server.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

let cacheResponseCount = 0;

for (const asynchronous of [false, true]) {
	test(`cached custom request ${asynchronous ? 'asynchronous' : 'synchronous'} fallback preserves URL credentials and native headers`, withServer, async (_t, server, got) => {
		const target = '/resource%2Fitem?b=2&a=1';
		let requests = 0;
		server.use((request, response) => {
			requests++;
			assert.strictEqual(request.url, target);
			assert.strictEqual(request.headers.authorization, `Basic ${Buffer.from('u@ser:p:ss').toString('base64')}`);
			assert.strictEqual(request.headers['x-custom'], 'present');
			response.setHeader('cache-control', 'public, max-age=60');
			response.end('authenticated');
		});
		const url = new URL(target, server.url);
		url.username = 'u@ser';
		url.password = 'p:ss';
		let calls = 0;
		const client = got.extend({
			cache: new Map(),
			request(actualUrl, options, callback) {
				calls++;
				assert.ok(actualUrl instanceof URL);
				assert.strictEqual(actualUrl.href, url.href);
				assert.strictEqual(options.path, target);
				assert.strictEqual(typeof callback, 'function');
				Reflect.set(options.headers!, 'x-custom', 'present');
				return asynchronous ? Promise.resolve(undefined) : undefined;
			},
		});
		const progress: number[] = [];
		const first = await client(url).on('uploadProgress', progressEvent => {
			progress.push(progressEvent.percent);
		});
		const second = await client(url);
		assert.strictEqual(first.body, 'authenticated');
		assert.strictEqual(second.body, first.body);
		assert.strictEqual(second.isFromCache, true);
		assert.strictEqual(first.request.options.headers['x-custom'], undefined);
		assert.strictEqual(progress.filter(percent => percent === 1).length, 1);
		assert.strictEqual(requests, 1);
		assert.strictEqual(calls, 1);
	});
}

test('cached custom HTTP/2 requests retain the URL-first overload and response callback', async t => {
	let streams = 0;
	const server = await createHttp2TestServer((stream, headers) => {
		streams++;
		stream.respond({':status': 200, 'cache-control': 'public, max-age=60'});
		stream.end(`${String(headers[':path'])}:${String(headers['x-custom'])}`);
	});
	t.after(server.close);
	let calls = 0;
	let callbacks = 0;
	const url = new URL('/resource//item?x=1&x=2', server.url);
	const client = got.extend({
		http2: true, cache: new Map(), https: {rejectUnauthorized: false},
		request(actualUrl, options, callback) {
			calls++;
			assert.ok(actualUrl instanceof URL);
			assert.strictEqual(actualUrl.href, url.href);
			assert.strictEqual(options.path, '/resource//item?x=1&x=2');
			Reflect.set(options.headers!, 'x-custom', 'h2');
			return autoHttp2Request(actualUrl, options, response => {
				callbacks++;
				callback!(response);
			});
		},
	});
	const first = await client(url);
	const second = await client(url);
	assert.strictEqual(first.body, '/resource//item?x=1&x=2:h2');
	assert.strictEqual(first.httpVersion, '2.0');
	assert.strictEqual(second.body, first.body);
	assert.strictEqual(second.isFromCache, true);
	assert.strictEqual(calls, 1);
	assert.strictEqual(callbacks, 1);
	assert.strictEqual(streams, 1);
});

test('cached custom requests keep explicitly omitted URL credentials out of native authentication', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		assert.strictEqual(request.headers.authorization, undefined);
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('anonymous');
	});
	const url = new URL(server.url);
	url.username = 'private-user';
	url.password = 'private-password';
	const response = await got(url, {
		cache: new Map(), headers: {authorization: undefined},
		request(actualUrl, options, callback) {
			assert.strictEqual(actualUrl.username, '');
			assert.strictEqual(actualUrl.password, '');
			assert.strictEqual(options.auth, undefined);
			return httpRequest(actualUrl, options, callback);
		},
	});
	assert.strictEqual(response.body, 'anonymous');
});

test('cached custom request cancellation releases the native URL-first request before adoption', withServer, async (_t, _server, got) => {
	const controller = new AbortController();
	let nativeRequest: ClientRequest | undefined;
	const request = got('', {
		cache: new Map(), signal: controller.signal, retry: {limit: 0},
		request(url, options, callback) {
			assert.ok(url instanceof URL);
			nativeRequest = httpRequest(url, options, callback);
			controller.abort();
			return nativeRequest;
		},
	});
	await assert.rejects(request, {code: 'ERR_ABORTED'});
	await setImmediate();
	assert.ok(nativeRequest);
	assert.strictEqual(nativeRequest.destroyed, true);
});

if (process.platform !== 'win32') {
	test('cached custom Unix requests preserve socket paths in the URL-first overload', withSocketServer, async (_t, server) => {
		let requests = 0;
		server.removeAllListeners('request');
		server.on('request', (request, response) => {
			requests++;
			response.setHeader('cache-control', 'public, max-age=60');
			response.end(request.url);
		});
		const url = new URL(`http://unix${server.socketPath}:/resource%2Fitem?x=1&x=2`);
		let calls = 0;
		const client = got.extend({
			enableUnixSockets: true, cache: new Map(), retry: {limit: 0},
			request(actualUrl, options, callback) {
				calls++;
				assert.ok(actualUrl instanceof URL);
				assert.strictEqual(actualUrl.href, url.href);
				assert.strictEqual(options.socketPath, server.socketPath);
				assert.strictEqual(options.path, '/resource%2Fitem?x=1&x=2');
				return httpRequest(actualUrl, options, callback);
			},
		});
		const first = await client(url);
		const second = await client(url);
		assert.strictEqual(first.body, '/resource%2Fitem?x=1&x=2');
		assert.strictEqual(second.body, first.body);
		assert.strictEqual(second.isFromCache, true);
		assert.strictEqual(calls, 1);
		assert.strictEqual(requests, 1);
	});
}

test('a cache URI collision cannot serve another resource when the server fails', withServer, async (_t, server, got) => {
	const requests: string[] = [];
	server.get('/', (request, response) => {
		requests.push(request.url);
		response.setHeader('cache-control', 'public, max-age=60, stale-if-error=60');
		if (request.url === '/?a=1&b=2') {
			response.end('first resource');
		} else {
			response.status(503).end('second resource unavailable');
		}
	});
	const cache = new Map();
	assert.strictEqual(await got('?a=1&b=2', {cache}).text(), 'first resource');
	const error = await rejects<HTTPError>(got('?b=2&a=1', {cache, retry: {limit: 0}}), HTTPError);
	assert.strictEqual(error.response.statusCode, 503);
	assert.strictEqual(error.response.body, 'second resource unavailable');
	assert.deepStrictEqual(requests, ['/?a=1&b=2', '/?b=2&a=1']);
});

for (const [firstPath, secondPath] of [
	['?a=1&b=2', '?b=2&a=1'],
	['?utm_source=one', '?utm_source=two'],
	['a//b', 'a/b'],
	['?a=1', '?a=1&utm_campaign=other'],
	['resource', 'resource/'],
	['?value=+', '?value=%20'],
	['?value=%2F', '?value=/'],
	['?value=%23', '?value=%2523'],
	['?target=first', '?target=second'],
	['?value=%', '?value=%25'],
] as const) {
	test(`cache entries preserve the effective request URI for ${firstPath} and ${secondPath}`, withServer, async (_t, server, got) => {
		const requests: string[] = [];
		server.use((request, response) => {
			requests.push(request.url);
			response.setHeader('cache-control', 'public, max-age=60');
			response.setHeader('etag', 'shared-validator');
			response.end(request.url);
		});
		const cache = new Map();
		const first = await got(firstPath, {cache});
		const second = await got(secondPath, {cache});
		assert.strictEqual(first.body, `/${firstPath}`);
		assert.strictEqual(second.body, `/${secondPath}`);
		assert.strictEqual(second.isFromCache, false);
		assert.deepStrictEqual(requests, [`/${firstPath}`, `/${secondPath}`]);
		for (const path of [firstPath, secondPath]) {
			// eslint-disable-next-line no-await-in-loop
			const cached = await got(path, {cache});
			assert.strictEqual(cached.body, `/${path}`);
			assert.strictEqual(cached.isFromCache, true);
		}

		assert.strictEqual(cache.size, 2);
		assert.strictEqual(requests.length, 2);
	});
}

test('cache URI identity preserves the authority trailing dot', withServer, async (_t, server, got) => {
	const requests: string[] = [];
	server.get('/', (request, response) => {
		requests.push(request.headers.host!);
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(request.headers.host);
	});
	const cache = new Map();
	const dnsLookup: LookupFunction = (_hostname, _options, callback) => {
		callback(null, '127.0.0.1', 4);
	};

	const firstUrl = new URL(server.url);
	const secondUrl = new URL(server.url);
	secondUrl.hostname += '.';
	for (const url of [firstUrl, secondUrl, firstUrl, secondUrl]) {
		// eslint-disable-next-line no-await-in-loop
		assert.strictEqual(await got(url, {cache, dnsLookup}).text(), url.host);
	}

	assert.deepStrictEqual(requests, [firstUrl.host, secondUrl.host]);
	assert.strictEqual(cache.size, 2);
});

test('cache URI identity ignores fragments and keeps caller response metadata', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/resource', (request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(request.url);
	});
	const cache = new Map();
	assert.strictEqual(await got('resource?value=%2F#first', {cache}).text(), '/resource?value=%2F');
	const response = await got('resource?value=%2F#second', {cache});
	assert.strictEqual(response.body, '/resource?value=%2F');
	assert.strictEqual(response.url, `${server.url}/resource?value=%2F#second`);
	assert.strictEqual(response.requestUrl.hash, '#second');
	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(requests, 1);
	assert.strictEqual(cache.size, 1);
});

test('cache URI identity restores original targets and conditional headers during revalidation', withServer, async (_t, server, got) => {
	const requests: Array<{url: string; validator?: string}> = [];
	server.use((request, response) => {
		requests.push({url: request.url, validator: request.headers['if-none-match']});
		response.setHeader('cache-control', 'public, max-age=0');
		response.setHeader('etag', '"version-one"');
		if (request.headers['if-none-match']) {
			response.status(304).end();
		} else {
			response.end(request.url);
		}
	});
	const cache = new Map();
	const path = 'a//b?utm_source=one&value=%2F';
	assert.strictEqual(await got(path, {cache}).text(), `/${path}`);
	const response = await got(path, {cache});
	assert.strictEqual(response.body, `/${path}`);
	assert.strictEqual(response.isFromCache, true);
	assert.deepStrictEqual(requests, [{url: `/${path}`, validator: undefined}, {url: `/${path}`, validator: '"version-one"'}]);
	assert.strictEqual(cache.size, 1);
});

test('opaque cache URI identities retain buffered POST payload separation', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(`${request.url}:${await getStream(request)}`);
	});
	const cache = new Map();
	for (const path of ['?a=1&b=2', '?b=2&a=1']) {
		for (const body of ['first', 'second']) {
			for (let index = 0; index < 2; index++) {
				// eslint-disable-next-line no-await-in-loop
				const response = await got.post(path, {cache, body});
				assert.strictEqual(response.body, `/${path}:${body}`);
				assert.strictEqual(response.isFromCache, index === 1);
			}
		}
	}

	assert.strictEqual(requests, 4);
	assert.strictEqual(cache.size, 4);
});

for (const method of ['PUT', 'PATCH'] as const) {
	test(`cache-enabled ${method} uploads do not hash bodies that cannot be stored`, withServer, async (t, server, got) => {
		const body = 'upload payload '.repeat(10_000);
		server[method === 'PUT' ? 'put' : 'patch']('/', async (request, response) => {
			response.setHeader('cache-control', 'public, max-age=60');
			response.end(await getStream(request));
		});
		const createHash = t.mock.method(crypto, 'createHash');
		const cache = new Map();
		let hookCalls = 0;
		const response = await got({
			method, body, cache, hooks: {
				beforeCache: [() => {
					hookCalls++;
				}],
			},
		});

		assert.strictEqual(response.body, body);
		assert.strictEqual(hookCalls, 1);
		assert.strictEqual(cache.size, 0);
		assert.strictEqual(createHash.mock.calls.filter(call => call.arguments[0] === 'md5').length, 0);
	});
}

for (const firstBody of [undefined, 'first payload']) {
	test(`GET uploads bypass entries cached with ${firstBody === undefined ? 'no body' : 'another body'}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', async (request, response) => {
			requests++;
			response.setHeader('cache-control', 'public, max-age=60');
			response.end(await getStream(request));
		});
		const cache = new Map();
		const first = await got({cache, allowGetBody: true, body: firstBody});
		const second = await got({cache, allowGetBody: true, body: 'second payload'});

		assert.strictEqual(first.body, firstBody ?? '');
		assert.strictEqual(second.body, 'second payload');
		assert.strictEqual(second.isFromCache, false);
		assert.strictEqual(requests, 2);

		if (firstBody === undefined) {
			const cached = await got({cache, allowGetBody: true, body: undefined});
			assert.strictEqual(cached.body, '');
			assert.strictEqual(cached.isFromCache, true);
			assert.strictEqual(cache.size, 1);
			assert.strictEqual(requests, 2);
		} else {
			assert.strictEqual(cache.size, 0);
		}
	});
}

for (const body of ['', Buffer.alloc(0), new Uint8Array(0)]) {
	test(`an empty GET ${typeof body === 'string' ? 'string' : body.constructor.name} body bypasses and preserves the bodyless cache entry`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			response.setHeader('cache-control', 'public, max-age=60');
			response.end(String(++requests));
		});
		const cache = new Map();
		assert.strictEqual(await got({cache}).text(), '1');
		const upload = await got({cache, allowGetBody: true, body});

		assert.strictEqual(upload.body, '2');
		assert.strictEqual(upload.isFromCache, false);
		assert.strictEqual(await got({cache, body: undefined}).text(), '1');
		assert.strictEqual(cache.size, 1);
		assert.strictEqual(requests, 2);
	});
}

test('manual writable uploads bypass the cache instead of sharing a bodyless key', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});
	const cache = new Map();
	for (const body of ['first payload', 'second payload']) {
		const request = got.stream.post({cache});
		const response = getStream(request);
		request.end(body);

		// eslint-disable-next-line no-await-in-loop -- Each completed upload must be available to the next cache lookup.
		assert.strictEqual(await response, body);
		assert.strictEqual(request.isFromCache, false);
	}

	assert.strictEqual(requests, 2);
	assert.strictEqual(cache.size, 0);
});

test('a manual upload does not replace a cached bodyless POST response', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(`${++requests}:${await getStream(request)}`);
	});
	const cache = new Map();
	assert.strictEqual(await got.post({cache}).text(), '1:');
	const upload = got.stream.post({cache});
	const response = getStream(upload);
	upload.end('payload');

	assert.strictEqual(await response, '2:payload');
	assert.strictEqual(upload.isFromCache, false);
	const cached = await got.post({cache, body: undefined});

	assert.strictEqual(cached.body, '1:');
	assert.strictEqual(cached.isFromCache, true);
	assert.strictEqual(cache.size, 1);
	assert.strictEqual(requests, 2);
});

for (const [description, createBody] of [
	['string', (value: string) => value],
	['Buffer', (value: string) => Buffer.from(value)],
	['Uint8Array view', (value: string) => {
		const backing = Buffer.from(`xx${value}yy`);
		return new Uint8Array(backing.buffer, backing.byteOffset + 2, Buffer.byteLength(value));
	}],
] as const) {
	test(`buffered POST ${description} bodies retain distinct cache keys in stream mode`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.post('/', async (request, response) => {
			requests++;
			response.setHeader('cache-control', 'public, max-age=60');
			response.end(await getStream(request));
		});
		const cache = new Map();
		assert.strictEqual(await got.post({cache, body: createBody('café:first')}).text(), 'café:first');
		assert.strictEqual(await getStream(got.stream.post({cache, body: createBody('café:second')})), 'café:second');
		const cached = got.stream.post({cache, body: createBody('café:first')});

		assert.strictEqual(await getStream(cached), 'café:first');
		assert.strictEqual(cached.isFromCache, true);
		assert.strictEqual(cache.size, 2);
		assert.strictEqual(requests, 2);
	});
}

test('a manual upload can use a cached bodyless GET after a 303 redirect', withServer, async (_t, server, got) => {
	let targetRequests = 0;
	let uploadedBody: string | undefined;
	server.get('/target', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(`target:${++targetRequests}`);
	});
	server.post('/start', async (request, response) => {
		uploadedBody = await getStream(request);
		response.writeHead(303, {location: '/target'});
		response.end();
	});
	const cache = new Map();
	assert.strictEqual(await got('target', {cache}).text(), 'target:1');
	const upload = got.stream.post('start', {cache});
	const response = getStream(upload);
	upload.end('payload');

	assert.strictEqual(await response, 'target:1');
	assert.strictEqual(upload.isFromCache, true);
	assert.strictEqual(uploadedBody, 'payload');
	assert.strictEqual(targetRequests, 1);
});

for (const [description, hook] of [
	['rejected asynchronous', 'async () => {throw new Error("invalid async hook rejection");}'],
	['resolved asynchronous', 'async () => {}'],
	['late rejecting', '() => new Promise((_resolve, reject) => {setTimeout(() => {reject(new Error("late invalid hook rejection"));}, 10);})'],
	['rejecting thenable', '() => ({then(_resolve, reject) {reject(new Error("invalid thenable rejection"));}, catch() {}})'],
]) {
	test(`a ${description} beforeCache hook reports its contract error without an unhandled rejection`, withServer, async (_t, server) => {
		server.get('/', cacheEndpoint);
		// Isolate unhandled rejections so the test can also detect a late process failure.
		const script = `
			import assert from 'node:assert/strict';
			import {setTimeout as delay} from 'node:timers/promises';
			import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
			const cache = new Map();
			let remainingHookCalled = false;
			await assert.rejects(got(process.argv[1], {
				cache,
				retry: {limit: 0},
				hooks: {beforeCache: [${hook}, () => {remainingHookCalled = true;}]},
			}), error => {
				assert.match(error.message, /beforeCache hooks must be synchronous/);
				assert.ok(error.cause instanceof TypeError);
				return true;
			});
			await delay(30);
			assert.strictEqual(remainingHookCalled, false);
			assert.strictEqual(cache.size, 0);
		`;
		await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url]);
	});
}

// A per-call counter rather than the clock: two requests can land in the same millisecond, which
// would make a test that compares two bodies a race instead of a check of what the cache served.
const cacheEndpoint: Handler = (_request, response) => {
	cacheResponseCount += 1;
	response.setHeader('Cache-Control', 'public, max-age=60');
	response.end(String(cacheResponseCount));
};

test('non-cacheable responses are not cached', withServer, async (_t, server, got) => {
	// A counter rather than the clock: two requests can land in the same millisecond, which would
	// turn the comparison below into a race instead of a check that the second one hit the server.
	let responseCount = 0;
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, no-cache, no-store');
		responseCount += 1;
		response.end(String(responseCount));
	});

	const cache = new Map();

	const firstResponseInt = Number((await got({cache})).body);
	const secondResponseInt = Number((await got({cache})).body);

	assert.strictEqual(cache.size, 0);
	assert.strictEqual(firstResponseInt < secondResponseInt, true);
});

test('cacheable responses are cached', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({cache});
	const secondResponse = await got({cache});

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.body, secondResponse.body);
});

test('cacheable responses to POST requests are cached', withServer, async (_t, server, got) => {
	server.post('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({method: 'POST', body: 'test', cache});
	const secondResponse = await got({method: 'POST', body: 'test', cache});

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.body, secondResponse.body);
});

test('QUERY responses are not cached', withServer, async (_t, server, got) => {
	let responses = 0;
	server.all('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end((++responses).toString());
	});

	const cache = new Map();

	const firstResponse = await got.query({json: {query: true}, cache});
	const secondResponse = await got.query({json: {query: true}, cache});

	assert.strictEqual(cache.size, 0);
	assert.strictEqual(firstResponse.body, '1');
	assert.strictEqual(secondResponse.body, '2');
});

test('non-cacheable responses to POST requests are not cached', withServer, async (_t, server, got) => {
	server.post('/', cacheEndpoint);

	const cache = new Map();

	// POST requests with streams are not cached
	const body1 = Readable.from(Buffer.from([1, 2, 3]));
	const body2 = Readable.from(Buffer.from([1, 2, 3]));

	const firstResponseInt = Number((await got({method: 'POST', body: body1, cache})).body);
	const secondResponseInt = Number((await got({method: 'POST', body: body2, cache})).body);

	assert.strictEqual(cache.size, 0);
	assert.strictEqual(firstResponseInt < secondResponseInt, true);
});

test('cached response is re-encoded to current encoding option', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const firstEncoding = 'base64';
	const secondEncoding = 'hex';

	const firstResponse = await got({cache, encoding: firstEncoding});
	const secondResponse = await got({cache, encoding: secondEncoding});

	const expectedSecondResponseBody = Buffer.from(firstResponse.body, firstEncoding).toString(secondEncoding);

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(secondResponse.body, expectedSecondResponseBody);
});

test('redirects are cached and re-used internally', withServer, async (_t, server, got) => {
	let status301Index = 0;
	server.get('/301', (_request, response) => {
		if (status301Index === 0) {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.setHeader('Location', '/');
			response.statusCode = 301;
		}

		response.end();
		status301Index++;
	});

	let status302Index = 0;
	server.get('/302', (_request, response) => {
		if (status302Index === 0) {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.setHeader('Location', '/');
			response.statusCode = 302;
		}

		response.end();
		status302Index++;
	});

	server.get('/', cacheEndpoint);

	const cache = new Map();
	const a1 = await got('301', {cache});
	const b1 = await got('302', {cache});

	const a2 = await got('301', {cache});
	const b2 = await got('302', {cache});

	assert.strictEqual(cache.size, 3);
	assert.strictEqual(a1.body, b1.body);
	assert.strictEqual(a1.body, a2.body);
	assert.strictEqual(b1.body, b2.body);
});

test('cached response has got options', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const options = {
		username: 'foo',
		cache,
	};

	await got(options);
	const secondResponse = await got(options);

	assert.strictEqual(secondResponse.request.options.username, options.username);
});

test('cache error throws `CacheError`', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = {};

	// @ts-expect-error Error tests
	await assert.rejects(got({cache}), errorMatching(CacheError, {code: 'ERR_CACHE_ACCESS'}));
});

test('cache error preserves `CacheError` code when underlying error has a code', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('ok');
	});

	let writes = 0;
	const cache = {
		get() {
			return undefined;
		},
		set() {
			writes++;
			const error = new Error('Cache write failed') as NodeJS.ErrnoException;
			error.code = 'EACCES';
			throw error;
		},
		delete() {},
		clear() {},
	} as any;

	await assert.rejects(got({cache, retry: {limit: 0}}), errorMatching(CacheError, {code: 'ERR_CACHE_ACCESS'}));
	assert.strictEqual(writes, 1);
});

test('doesn\'t cache response when received HTTP error', withServer, async (_t, server, got) => {
	let isFirstErrorCalled = false;
	server.get('/', (_request, response) => {
		if (!isFirstErrorCalled) {
			response.end('ok');
			return;
		}

		isFirstErrorCalled = true;
		response.statusCode = 502;
		response.end('received 502');
	});

	const cache = new Map();

	const {statusCode, body} = await got('', {cache, throwHttpErrors: false});
	assert.strictEqual(statusCode, 200);
	assert.strictEqual(body, 'ok');
});

test('cache should work with http2', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const instance = got.extend({
		cache: true,
		http2: true,
	});

	await assert.doesNotReject(instance(''));
});

test('`isFromCache` stream property is undefined before the `response` event', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const stream = got.stream({cache});
	assert.strictEqual(stream.isFromCache, undefined);

	await getStream(stream);
});

test('`isFromCache` stream property is false after the `response` event', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const stream = got.stream({cache});

	const response = await onceValue<Response>(stream, 'response');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(stream.isFromCache, false);

	await getStream(stream);
});

test('`isFromCache` stream property is true if the response was cached', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	await getStream(got.stream({cache}));
	const stream = got.stream({cache});

	const response = await onceValue<Response>(stream, 'response');
	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(stream.isFromCache, true);

	await getStream(stream);
});

test('can disable cache by extending the instance', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const instance = got.extend({cache});

	await getStream(instance.stream(''));
	const stream = instance.extend({cache: false}).stream('');

	const response = await onceValue<Response>(stream, 'response');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(stream.isFromCache, false);

	await getStream(stream);
});

test('does not break POST requests', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		request.resume();
		response.end(JSON.stringify(request.headers));
	});

	const headers = await got.post('', {
		body: '',
		cache: new Map(),
	}).json<{'content-length': string}>();

	assert.strictEqual(headers['content-length'], '0');
});

test('decompresses cached responses', withServer, async (_t, server, got) => {
	const etag = 'foobar';

	const payload = JSON.stringify({foo: 'bar'});
	const compressed = await promisify(gzip)(payload);

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === etag) {
			response.statusCode = 304;
			response.end();
		} else {
			response.setHeader('content-encoding', 'gzip');
			response.setHeader('cache-control', 'public, max-age=60');
			response.setHeader('etag', etag);
			response.end(compressed);
		}
	});

	const cache = new Map();

	for (let i = 0; i < 2; i++) {
		// eslint-disable-next-line no-await-in-loop
		await assert.doesNotReject(got({
			cache,
			responseType: 'json',
			decompress: true,
			retry: {
				limit: 2,
			},
		}));
	}

	assert.strictEqual(cache.size, 1);
});

test('can replace the instance\'s HTTP cache', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const secondCache = new Map();

	const instance = got.extend({
		mutableDefaults: true,
		cache,
	});

	await assert.doesNotReject(instance(''));
	await assert.doesNotReject(instance(''));

	instance.defaults.options.cache = secondCache;

	await assert.doesNotReject(instance(''));
	await assert.doesNotReject(instance(''));

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(secondCache.size, 1);
});

test('does not hang on huge response', withServer, async (_t, server, got) => {
	const bufferSize = 3 * 16 * 1024;
	const times = 10;

	const buffer = Buffer.alloc(bufferSize);

	server.get('/', async (_request, response) => {
		for (let i = 0; i < 10; i++) {
			response.write(buffer);

			// eslint-disable-next-line no-await-in-loop
			await delay(100);
		}

		response.end();
	});

	const body = await got('', {
		cache: new Map(),
	}).buffer();

	assert.strictEqual(body.length, bufferSize * times);
});

test('cached response ETag', withServer, async (_t, server, got) => {
	const etag = 'foobar';
	const body = 'responseBody';

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === etag) {
			response.writeHead(304);
			response.end();
		} else {
			response.writeHead(200, {etag});
			response.end(body);
		}
	});

	const cache = new Map();

	const originalResponse = await got({cache});

	assert.strictEqual(originalResponse.isFromCache, false);
	assert.strictEqual(originalResponse.body, body);

	await delay(100); // Added small delay in order to wait the cache to be populated

	assert.strictEqual(cache.size, 1);

	const cachedResponse = await got({cache});

	assert.strictEqual(cachedResponse.isFromCache, true);
	assert.strictEqual(cachedResponse.body, body);
});

// Kept disabled because it depends on an external endpoint; local HTTP/2 cache coverage exists above.
// test('works with http2', async t => {
// 	const cache = new Map();

// 	const client = got.extend({
// 		http2: true,
// 		cache,
// 	});

// 	try {
// 		await client('https://httpbin.org/anything');

// 		t.pass();
// 	} catch (error: any) {
// 		if (error.message.includes('install Node.js')) {
// 			t.pass();
// 			return;
// 		}

// 		t.fail(error.message);
// 	}
// });

test('http-cache-semantics typings', _t => {
	const instance = got.extend({
		cacheOptions: {
			shared: false,
		},
	});

	assert.strictEqual(instance.defaults.options.cacheOptions.shared, false);
});

test('allows internal modifications', withServer, async (_t, server, got) => {
	let requestCount = 0;

	server.get('/test', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.writeHead(401);
			response.end();
		} else {
			response.writeHead(200);
			response.end(JSON.stringify({wat: ['123']}));
		}
	});
	const client = got.extend({
		cache: new Map(),
		hooks: {
			afterResponse: [
				async (response, retryWithMergedOptions) => response.statusCode === 401 ? retryWithMergedOptions({}) : response,
			],
		},
	});

	await assert.doesNotReject(client.get('test'));
});

test('response.complete is true when using keepalive agent', withServer, async (_t, server, got) => {
	const agent = {
		http: new Agent({keepAlive: true}),
	};

	const etag = 'foobar';

	const payload = JSON.stringify({foo: 'bar'});
	const compressed = await promisify(gzip)(payload);

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === etag) {
			response.statusCode = 304;
			response.end();
		} else {
			response.setHeader('content-encoding', 'gzip');
			response.setHeader('cache-control', 'public, max-age=60');
			response.setHeader('etag', etag);
			response.end(compressed);
		}
	});

	const cache = new Map();

	const first = await got({
		cache,
		responseType: 'json',
		decompress: true,
		retry: {
			limit: 2,
		},
		agent,
	});

	assert.strictEqual(first.complete, true);
});

test('revalidated uncompressed responses are retrieved from cache', {timeout: 5000}, withServer, async (_t, server, got) => {
	let revalidated = false;

	const payload = JSON.stringify([1]);

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === 'asdf') {
			revalidated = true;
			response.writeHead(304, {etag: 'asdf'});
		} else {
			response.writeHead(200, {
				etag: 'asdf',
				'cache-control': 'public, max-age=1, s-maxage=1',
				'content-type': 'application/json',
			});
			response.write(payload);
		}

		response.end();
	});
	const client = got.extend({cache: new Map(), responseType: 'json'});

	const firstResponse = (await client('')) as unknown as Response<number[]>;
	assert.strictEqual(revalidated, false);
	assert.deepStrictEqual(firstResponse.body, [1]);
	assert.strictEqual(firstResponse.complete, true);

	await new Promise<void>(resolve => {
		setTimeout(resolve, 3000);
	});

	console.log('max-age has expired, performing second request');

	const secondResponse = (await client('')) as unknown as Response<number[]>;
	assert.strictEqual(revalidated, true);
	assert.deepStrictEqual(secondResponse.body, [1]);
	assert.strictEqual(secondResponse.complete, true); // Fails here.
});

test('revalidated compressed responses are retrieved from cache', {timeout: 5000}, withServer, async (_t, server, got) => {
	let revalidated = false;

	const payload = JSON.stringify([1]);
	const compressed = await promisify(gzip)(payload);

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === 'asdf') {
			revalidated = true;
			response.writeHead(304, {etag: 'asdf'});
		} else {
			response.writeHead(200, {
				etag: 'asdf',
				'cache-control': 'public, max-age=1, s-maxage=1',
				'content-type': 'application/json',
				'content-encoding': 'gzip',
			});
			response.write(compressed);
		}

		response.end();
	});
	const client = got.extend({cache: new Map(), responseType: 'json'});

	const firstResponse = (await client('')) as unknown as Response<number[]>;
	assert.strictEqual(revalidated, false);
	assert.deepStrictEqual(firstResponse.body, [1]);
	assert.strictEqual(firstResponse.complete, true);

	await new Promise<void>(resolve => {
		setTimeout(resolve, 3000);
	});

	console.log('max-age has expired, performing second request (but it will actually hang)');

	const secondResponse = (await client('')) as unknown as Response<number[]>;
	assert.strictEqual(revalidated, true);
	assert.deepStrictEqual(secondResponse.body, [1]);
	assert.strictEqual(secondResponse.complete, true);
});

test.skip('revalidated uncompressed responses from github are retrieved from cache', {timeout: 70_000}, async _t => {
	const client = got.extend({
		cache: new Map(),
		cacheOptions: {shared: false},
		responseType: 'json',
		headers: {
			'accept-encoding': 'identity',
			// eslint-disable-next-line unicorn/consistent-conditional-object-spread -- `&&` spreads an empty token as `{0: ''}`, so the absent case has to stay explicit.
			...(process.env.GITHUB_TOKEN ? {authorization: `token ${process.env.GITHUB_TOKEN}`} : {}),
		},
	});

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		assert.strictEqual((response.body as any).name, 'Spoon-Knife');
		assert.strictEqual(response.complete, true);
	}

	await new Promise<void>(resolve => {
		setTimeout(resolve, 65_000);
	});

	console.log('max-age has expired, performing second request');

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		assert.strictEqual((response.body as any).name, 'Spoon-Knife');
		assert.strictEqual(response.complete, true); // Fails here.
	}
});

test.skip('revalidated compressed responses from github are retrieved from cache', {timeout: 70_000}, async _t => {
	const client = got.extend({
		cache: new Map(),
		cacheOptions: {shared: false},
		responseType: 'json',
		headers: process.env.GITHUB_TOKEN ? {authorization: `token ${process.env.GITHUB_TOKEN}`} : {},
	});

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		assert.strictEqual((response.body as any).name, 'Spoon-Knife');
		assert.strictEqual(response.complete, true);
	}

	await new Promise<void>(resolve => {
		setTimeout(resolve, 65_000);
	});

	console.log('max-age has expired, performing second request (but it will actually hang)');

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		assert.strictEqual((response.body as any).name, 'Spoon-Knife');
		assert.strictEqual(response.complete, true);
	}
});

test('QuickLRU works as cache adapter (auto-wrapped)', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	// Using dynamic import to handle potential missing dependency
	let cacheConstructor;
	try {
		cacheConstructor = (await import('quick-lru')).default;
	} catch {
		// QuickLRU not available, skipping test
		return;
	}

	// eslint-disable-next-line new-cap
	const cache = new cacheConstructor({maxSize: 1000});

	// QuickLRU is auto-wrapped by Got to be compatible with StorageAdapter
	const firstResponse = await got({cache: cache as any});
	const secondResponse = await got({cache: cache as any});

	assert.strictEqual(firstResponse.body, secondResponse.body);
	assert.strictEqual(firstResponse.isFromCache, false);
	assert.strictEqual(secondResponse.isFromCache, true);
	assert.strictEqual(cache.size, 1);
});

test('beforeCache hook: returning false prevents caching', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				(): false => false,
			],
		},
	});

	const secondResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				(): false => false,
			],
		},
	});

	assert.strictEqual(cache.size, 0);
	assert.notStrictEqual(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: returning void uses default caching', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				() => undefined,
			],
		},
	});

	const secondResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				() => undefined,
			],
		},
	});

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: conditionally prevent caching based on status code', withServer, async (_t, server, got) => {
	server.get('/success', cacheEndpoint);
	server.get('/error', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.statusCode = 500;
		response.end('error');
	});

	const cache = new Map();

	const hooks = {
		beforeCache: [
			(response: any) => response.statusCode >= 400 ? false : undefined,
		],
	};

	await got('success', {cache, hooks});
	await got('error', {cache, hooks, throwHttpErrors: false});

	assert.strictEqual(cache.size, 1);
});

test('beforeCache hook: modify cache-control headers', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'no-cache');
		response.end(Date.now().toString());
	});

	const cache = new Map();

	const firstResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => {
					response.headers['cache-control'] = 'public, max-age=3600';
				},
			],
		},
	});

	const secondResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => {
					response.headers['cache-control'] = 'public, max-age=3600';
				},
			],
		},
	});

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: multiple hooks are executed in order', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const order: number[] = [];

	await got({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => {
					order.push(1);
					response.headers['x-hook-1'] = 'executed';
				},
				(response: any) => {
					order.push(2);
					assert.strictEqual(response.headers['x-hook-1'], 'executed');
				},
			],
		},
	});

	assert.deepStrictEqual(order, [1, 2]);
	assert.strictEqual(cache.size, 1);
});

test('beforeCache hook: first hook returning false skips remaining hooks', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	let secondHookCalled = false;

	await got({
		cache,
		hooks: {
			beforeCache: [
				(): false => false,
				() => {
					secondHookCalled = true;
					return undefined;
				},
			],
		},
	});

	assert.strictEqual(secondHookCalled, false);
	assert.strictEqual(cache.size, 0);
});

test('beforeCache hook: not called when cache option is disabled', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let hookCalled = false;

	await got({
		hooks: {
			beforeCache: [
				() => {
					hookCalled = true;
					return undefined;
				},
			],
		},
	});

	assert.strictEqual(hookCalled, false);
});

test('beforeCache hook: works with extended instances', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const instance = got.extend({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => response.statusCode >= 400 ? false : undefined,
			],
		},
	});

	const firstResponse = await instance('');
	const secondResponse = await instance('');

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: errors are propagated', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const error = await rejects(got({
		cache,
		hooks: {
			beforeCache: [
				() => {
					throw new Error('Hook error message');
				},
			],
		},
	}));

	assert.strictEqual(error?.message, 'Hook error message');
});

test('beforeCache hook: returning undefined caches the original response correctly', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	// First request - hook returns undefined
	const firstResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				() => undefined,
			],
		},
	});

	// Second request - should get cached response
	const secondResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				() => undefined,
			],
		},
	});

	// Verify caching worked correctly
	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.body, secondResponse.body);
	assert.strictEqual(firstResponse.isFromCache, false);
	assert.strictEqual(secondResponse.isFromCache, true);
});

test('beforeCache hook: mixed hook results work correctly', withServer, async (_t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	// First request - first hook returns undefined, second hook modifies and returns
	const firstResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => {
					// This hook returns undefined - its mutations take effect
					response.headers['x-ignored'] = 'ignored';
					return undefined;
				},
				(response: any) => {
					// This hook also mutates - all mutations are cached
					response.headers['x-custom'] = 'cached';
				},
			],
		},
	});

	// Second request - should get cached response with modifications from the hook that returned
	const secondResponse = await got({cache});

	assert.strictEqual(cache.size, 1);
	assert.strictEqual(firstResponse.isFromCache, false);
	assert.strictEqual(secondResponse.isFromCache, true);
	// The cached response should have the custom header from the hook that returned
	assert.strictEqual(secondResponse.headers['x-custom'], 'cached');
	// Both mutations are included because mutations work directly
	assert.strictEqual(secondResponse.headers['x-ignored'], 'ignored');
});

test('beforeCache hook: response body is correctly cached when hook returns undefined', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(`Response ${requestCount}`);
	});

	const cache = new Map();

	// First request
	const firstResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				() => undefined,
			],
		},
	});

	// Second request - should be from cache
	const secondResponse = await got({
		cache,
		hooks: {
			beforeCache: [
				() => undefined,
			],
		},
	});

	// Verify the body was cached correctly (not corrupted by defensive copy)
	assert.strictEqual(firstResponse.body, 'Response 1');
	assert.strictEqual(secondResponse.body, 'Response 1'); // Same body from cache
	assert.strictEqual(requestCount, 1); // Only one actual request was made
	assert.strictEqual(secondResponse.isFromCache, true);
});

// RFC 9111 section 4.3.1: forward stored validators when revalidating.
for (const {name, validators, expectedHeaders} of [
	{name: 'strong ETag', validators: {etag: '"version-one"'}, expectedHeaders: {'if-none-match': '"version-one"'}},
	{name: 'weak ETag', validators: {etag: 'W/"version-one"'}, expectedHeaders: {'if-none-match': 'W/"version-one"'}},
	{name: 'Last-Modified', validators: {'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT'}, expectedHeaders: {'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT'}},
	{
		name: 'both validators',
		validators: {etag: '"version-one"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT'},
		expectedHeaders: {'if-none-match': '"version-one"', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT'},
	},
]) {
	test(`cache semantics: revalidation forwards ${name} and retains the stored body`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (request, response) => {
			requests++;
			if (requests === 1) {
				response.writeHead(200, {...validators, 'cache-control': 'max-age=0', 'content-type': 'application/json'});
				response.end('{"value":"cached"}');
				return;
			}

			for (const [header, value] of Object.entries(expectedHeaders)) {
				assert.strictEqual(request.headers[header], value);
			}

			response.writeHead(304, validators).end();
		});
		const client = got.extend({cache: new Map(), responseType: 'json'});
		await client('');
		const response = await client('');

		assert.strictEqual(requests, 2);
		assert.strictEqual(response.statusCode, 200);
		assert.deepStrictEqual(response.body, {value: 'cached'});
		assert.strictEqual(response.isFromCache, true);
		assert.strictEqual(response.complete, true);
	});
}

// RFC 9111 sections 3.2 and 4.3.4: 304 metadata updates the stored response.
test('cache semantics: 304 refreshes existing metadata and freshness', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		if (++requests === 1) {
			response.writeHead(200, {
				etag: '"one"', 'cache-control': 'max-age=0', 'x-revision': 'old', 'content-type': 'text/plain',
			}).end('stored body');
			return;
		}

		assert.strictEqual(request.headers['if-none-match'], '"one"');
		response.writeHead(304, {etag: '"one"', 'cache-control': 'max-age=600', 'x-revision': 'new'}).end();
	});
	const client = got.extend({cache: new Map()});
	await client('');
	const revalidated = await client('');
	const cached = await client('');

	for (const response of [revalidated, cached]) {
		assert.strictEqual(response.body, 'stored body');
		assert.strictEqual(response.headers['x-revision'], 'new');
		assert.strictEqual(response.headers['content-type'], 'text/plain');
		assert.strictEqual(response.headers['cache-control'], 'max-age=600');
		assert.strictEqual(response.isFromCache, true);
	}

	assert.strictEqual(requests, 2);
});

// The http-cache-semantics dependency drops new 304 fields, contrary to RFC 9111 sections 3.2 and 4.3.4.
test.failing('cache semantics: 304 adds metadata absent from the stored response', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		if (++requests === 1) {
			response.writeHead(200, {etag: '"one"', 'cache-control': 'max-age=0'}).end('stored body');
			return;
		}

		assert.strictEqual(request.headers['if-none-match'], '"one"');
		response.writeHead(304, {etag: '"one"', 'cache-control': 'max-age=600', 'x-revision': 'new'}).end();
	});
	const client = got.extend({cache: new Map()});
	await client('');
	const response = await client('');

	assert.strictEqual(response.body, 'stored body');
	assert.strictEqual(requests, 2);
	assert.strictEqual(response.headers['x-revision'], 'new');
});

test('cache semantics: a full revalidation response replaces the cached representation', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		if (++requests === 1) {
			response.writeHead(200, {etag: '"old"', 'cache-control': 'max-age=0'}).end('old body');
			return;
		}

		assert.strictEqual(request.headers['if-none-match'], '"old"');
		response.writeHead(200, {etag: '"new"', 'cache-control': 'max-age=600'}).end('new body');
	});
	const client = got.extend({cache: new Map()});
	await client('');
	const replacement = await client('');
	const cached = await client('');

	assert.strictEqual(replacement.isFromCache, false);
	assert.strictEqual(replacement.body, 'new body');
	assert.strictEqual(cached.isFromCache, true);
	assert.strictEqual(cached.body, 'new body');
	assert.strictEqual(cached.headers.etag, '"new"');
	assert.strictEqual(requests, 2);
});

// RFC 9111 section 4.1: every selecting field must match, including absence.
for (const [firstLanguage, secondLanguage] of [['en', 'fr'], [undefined, 'en'], ['en', undefined]]) {
	test(`cache semantics: Vary distinguishes language ${firstLanguage} from ${secondLanguage}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (request, response) => {
			requests++;
			response.writeHead(200, {vary: 'Accept-Language', 'cache-control': 'max-age=600'}).end(request.headers['accept-language'] ?? 'default');
		});
		const client = got.extend({cache: new Map()});
		await client('', {headers: {'accept-language': firstLanguage}});
		const response = await client('', {headers: {'accept-language': secondLanguage}});

		assert.strictEqual(response.body, secondLanguage ?? 'default');
		assert.strictEqual(response.isFromCache, false);
		assert.strictEqual(requests, 2);
	});
}

test('cache semantics: Vary matches multiple fields and ignores unrelated request headers', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(200, {vary: 'Accept-Language, X-Format', 'cache-control': 'max-age=600'}).end('matching representation');
	});
	const client = got.extend({cache: new Map(), headers: {'accept-language': 'en', 'x-format': 'compact'}});
	await client('', {headers: {'x-trace': 'first'}});
	const response = await client('', {headers: {'x-trace': 'second'}});
	const changed = await client('', {headers: {'x-format': 'expanded'}});

	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(response.body, 'matching representation');
	assert.strictEqual(changed.isFromCache, false);
	assert.strictEqual(requests, 2);
});

test('cache semantics: Vary star prevents reuse even for identical requests', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.writeHead(200, {vary: '*', 'cache-control': 'max-age=600'}).end(String(++requests));
	});
	const client = got.extend({cache: new Map()});
	await client('');
	const response = await client('');

	assert.strictEqual(response.body, '2');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(requests, 2);
});

for (const {name, responseControl, requestControl} of [
	{name: 'response no-cache', responseControl: 'no-cache, max-age=600', requestControl: undefined},
	{name: 'request no-cache', responseControl: 'max-age=600', requestControl: 'no-cache'},
	{name: 'stale must-revalidate despite max-stale', responseControl: 'max-age=0, must-revalidate', requestControl: 'max-stale'},
]) {
	test(`cache semantics: ${name} requires validation before reuse`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (request, response) => {
			if (++requests === 1) {
				response.writeHead(200, {etag: '"one"', 'cache-control': responseControl}).end('stored body');
				return;
			}

			assert.strictEqual(request.headers['if-none-match'], '"one"');
			response.writeHead(304, {etag: '"one"', 'cache-control': responseControl}).end();
		});
		const client = got.extend({cache: new Map()});
		await client('');
		const response = await client('', {headers: {'cache-control': requestControl}});

		assert.strictEqual(response.body, 'stored body');
		assert.strictEqual(response.isFromCache, true);
		assert.strictEqual(requests, 2);
	});
}

for (const source of ['request', 'response']) {
	test(`cache semantics: ${source} no-store prevents storing a new response`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			response.writeHead(200, {'cache-control': source === 'response' ? 'no-store, max-age=600' : 'max-age=600'}).end(String(++requests));
		});
		const cache = new Map();
		const client = got.extend({cache, headers: {'cache-control': source === 'request' ? 'no-store' : undefined}});
		await client('');
		const response = await client('');

		assert.strictEqual(response.body, '2');
		assert.strictEqual(response.isFromCache, false);
		assert.strictEqual(cache.size, 0);
		assert.strictEqual(requests, 2);
	});
}

for (const shared of [true, false]) {
	test(`cache semantics: private responses with shared cache ${shared}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			response.writeHead(200, {'cache-control': 'private, max-age=600'}).end(String(++requests));
		});
		const client = got.extend({cache: new Map(), cacheOptions: {shared}});
		await client('');
		const response = await client('');

		assert.strictEqual(response.body, shared ? '2' : '1');
		assert.strictEqual(response.isFromCache, !shared);
		assert.strictEqual(requests, shared ? 2 : 1);
	});

	test(`cache semantics: s-maxage overrides max-age only for shared cache ${shared}`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (request, response) => {
			requests++;
			if (requests > 1) {
				assert.strictEqual(request.headers['if-none-match'], '"one"');
				response.writeHead(304, {etag: '"one"'}).end();
				return;
			}

			response.writeHead(200, {etag: '"one"', 'cache-control': 'public, max-age=600, s-maxage=0'}).end('stored body');
		});
		const client = got.extend({cache: new Map(), cacheOptions: {shared}});
		await client('');
		const response = await client('');

		assert.strictEqual(response.body, 'stored body');
		assert.strictEqual(response.isFromCache, true);
		assert.strictEqual(requests, shared ? 2 : 1);
	});
}

test('cache semantics: max-age takes precedence over an expired Expires value', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(200, {'cache-control': 'max-age=600', expires: 'Wed, 01 Jan 2020 00:00:00 GMT'}).end('fresh body');
	});
	const client = got.extend({cache: new Map()});
	await client('');
	const response = await client('');

	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(response.body, 'fresh body');
	assert.strictEqual(requests, 1);
});

test('cache semantics: Age contributes to expiration without waiting for wall-clock time', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		if (++requests === 1) {
			response.writeHead(200, {etag: '"one"', 'cache-control': 'max-age=60', age: '120'}).end('stored body');
			return;
		}

		assert.strictEqual(request.headers['if-none-match'], '"one"');
		response.writeHead(304, {etag: '"one"', age: '0'}).end();
	});
	const client = got.extend({cache: new Map()});
	await client('');
	const response = await client('');

	assert.strictEqual(response.body, 'stored body');
	assert.strictEqual(requests, 2);
});

test('cache semantics: distinct query values retain separate representations', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		requests++;
		response.writeHead(200, {'cache-control': 'max-age=600'}).end(request.url);
	});
	const client = got.extend({cache: new Map()});
	await client('?page=1');
	const secondPage = await client('?page=2');
	const firstPage = await client('?page=1');

	assert.strictEqual(secondPage.body, '/?page=2');
	assert.strictEqual(secondPage.isFromCache, false);
	assert.strictEqual(firstPage.body, '/?page=1');
	assert.strictEqual(firstPage.isFromCache, true);
	assert.strictEqual(requests, 2);
});

test('cache semantics: cached HEAD responses cannot replace GET response bodies', withServer, async (_t, server, got) => {
	let requests = 0;
	server.all('/', (request, response) => {
		requests++;
		response.writeHead(200, {'cache-control': 'max-age=600'}).end(request.method === 'HEAD' ? undefined : 'GET body');
	});
	const client = got.extend({cache: new Map()});
	await client.head('');
	const response = await client('');
	const cached = await client('');

	assert.strictEqual(response.body, 'GET body');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(cached.body, 'GET body');
	assert.strictEqual(cached.isFromCache, true);
	assert.strictEqual(requests, 2);
});

test('native FormData uploads work with cache enabled', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});

	const form = new FormData();
	form.set('field', 'form payload');

	const withoutCache = await got.post({body: form});
	assert.strictEqual(withoutCache.body.includes('form payload'), true);

	const cache = new Map();
	const withCache = await got.post({body: form, cache});
	assert.strictEqual(withCache.body.includes('name="field"'), true);
	assert.strictEqual(withCache.body.includes('form payload'), true);
	assert.strictEqual(withCache.isFromCache, false);
	assert.strictEqual(cache.size, 0);
});

test('Web stream uploads work with cache enabled', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});

	const cache = new Map();
	const response = await got.post({
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('streamed payload'));
				controller.close();
			},
		}),
		cache,
	});

	assert.strictEqual(response.body, 'streamed payload');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(cache.size, 0);
});

test('Node stream uploads keep bypassing the cache', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});

	const cache = new Map();
	const response = await got.post({
		body: Readable.from(['streamed payload']),
		cache,
	});

	assert.strictEqual(response.body, 'streamed payload');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(cache.size, 0);
});

test('string uploads remain cacheable', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', (_request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('stored');
	});

	const cache = new Map();
	await got.post({body: 'form payload', cache});
	const response = await got.post({body: 'form payload', cache});

	assert.strictEqual(response.body, 'stored');
	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(requests, 1);
	assert.strictEqual(cache.size, 1);
});

test('async generator uploads bypass the cache', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});

	async function * body() {
		yield 'streamed payload';
	}

	const cache = new Map();
	const response = await got.post({body: body(), cache});

	assert.strictEqual(response.body, 'streamed payload');
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(cache.size, 0);
	assert.strictEqual(requests, 1);
});

// The cache layer must see the hook's changes, but the caller must keep the server's headers.
test('beforeCache changes do not reach the response the caller receives', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.setHeader('x-from-server', 'yes');
		response.end('cached body');
	});

	const cache = new Map();
	const first = await got({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => {
					response.headers['x-from-hook'] = 'added';
					response.headers.pragma = 'no-cache';
				},
			],
		},
	});

	assert.strictEqual(first.headers['x-from-server'], 'yes');
	assert.strictEqual(first.headers['x-from-hook'], undefined);
	assert.strictEqual(first.headers.pragma, undefined);

	// The hook's headers are what got cached, so they come back on a later request.
	const second = await got({cache});
	assert.strictEqual(second.isFromCache, true);
	assert.strictEqual(second.headers['x-from-server'], 'yes');
	assert.strictEqual(second.headers['x-from-hook'], 'added');
	assert.strictEqual(second.headers.pragma, 'no-cache');
});

test('beforeCache returning false does not rewrite the caller headers', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.setHeader('x-from-server', 'yes');
		response.end('uncached body');
	});

	const response = await got({
		cache: new Map(),
		hooks: {
			beforeCache: [
				(): false => false,
			],
		},
	});

	assert.strictEqual(response.headers['cache-control'], 'public, max-age=60');
	assert.strictEqual(response.headers.pragma, undefined);
	assert.strictEqual(response.headers.expires, undefined);
});

// With a cache adapter the `close` fallback is skipped, so the `error` path is the only place
// an early connection failure can be reported.
for (const [name, cache] of [
	['a Map', new Map()],
	['the shared cache', true],
] as Array<[string, Map<string, unknown> | boolean]>) {
	test(`an early connection failure settles the request with ${name}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.socket?.destroy();
		});

		const error = await rejects(got('', {
			cache: cache as Map<string, unknown>,
			retry: {
				limit: 0,
			},
		}));

		assert.strictEqual(error.code, 'ECONNRESET');
	});
}

test('a stream reports an early connection failure with a cache', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.socket?.destroy();
	});

	const request = got.stream('', {
		cache: new Map(),
		retry: {
			limit: 0,
		},
	});

	const error = await rejects(getStream(request));
	assert.strictEqual(error.code, 'ECONNRESET');
});

test('beforeCache cannot edit array-valued caller headers through the cache copy', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.setHeader('set-cookie', 'real=1; Path=/');
		response.end('cached body');
	});

	const cache = new Map();
	const first = await got({
		cache,
		hooks: {
			beforeCache: [
				(response: any) => {
					response.headers['set-cookie'].push('injected=1; Path=/');
				},
			],
		},
	});

	assert.deepStrictEqual(first.headers['set-cookie'], ['real=1; Path=/']);
});

test('a cached error response is replayed as an HTTPError from the cache', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(404, {'cache-control': 'public, max-age=60'}).end('missing');
	});

	const cache = new Map();

	const first = await rejects<HTTPError>(got({cache, retry: {limit: 0}}), errorMatching(HTTPError, {code: 'ERR_NON_2XX_3XX_RESPONSE'}));
	const second = await rejects<HTTPError>(got({cache, retry: {limit: 0}}), errorMatching(HTTPError, {code: 'ERR_NON_2XX_3XX_RESPONSE'}));

	assert.strictEqual(requests, 1);
	assert.strictEqual(first.response.isFromCache, false);
	assert.strictEqual(second.response.isFromCache, true);
	assert.strictEqual(second.response.statusCode, 404);
	assert.strictEqual(second.response.body, 'missing');
	assert.match(second.message, /^Request failed with status code 404 \(Not Found\): GET /v);
});

test('a cached error response resolves with ok false when HTTP errors are not thrown', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(410, {'cache-control': 'public, max-age=60'}).end('gone');
	});

	const cache = new Map();

	await got({cache, throwHttpErrors: false});
	const response = await got({cache, throwHttpErrors: false});

	assert.strictEqual(requests, 1);
	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(response.statusCode, 410);
	assert.strictEqual(response.ok, false);
	assert.strictEqual(response.body, 'gone');
});

test('a fully cached redirect chain reports its redirect URLs and the cached final response', withServer, async (_t, server, got) => {
	const requested: string[] = [];
	server.get('/start', (request, response) => {
		requested.push(request.url);
		response.writeHead(301, {'cache-control': 'public, max-age=60', location: '/destination'}).end();
	});
	server.get('/destination', (request, response) => {
		requested.push(request.url);
		response.writeHead(200, {'cache-control': 'public, max-age=60'}).end('destination');
	});

	const cache = new Map();

	const first = await got('start', {cache});
	const second = await got('start', {cache});

	assert.deepStrictEqual(requested, ['/start', '/destination']);
	assert.strictEqual(first.isFromCache, false);
	assert.strictEqual(second.isFromCache, true);
	assert.strictEqual(second.body, 'destination');
	assert.strictEqual(second.url, `${server.url}/destination`);
	assert.deepStrictEqual(second.redirectUrls.map(url => url.href), [`${server.url}/destination`]);
});

test('a cached redirect is returned as the response when redirects are not followed', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/start', (_request, response) => {
		requests++;
		response.writeHead(301, {'cache-control': 'public, max-age=60', location: '/destination'}).end();
	});

	const cache = new Map();

	await got('start', {cache, followRedirect: false});
	const response = await got('start', {cache, followRedirect: false});

	assert.strictEqual(requests, 1);
	assert.strictEqual(response.isFromCache, true);
	assert.strictEqual(response.statusCode, 301);
	assert.strictEqual(response.headers.location, '/destination');
	assert.deepStrictEqual(response.redirectUrls, []);
});

test('a cached response does not re-apply Set-Cookie to the cookie jar', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.setHeader('set-cookie', 'session=value-1');
		response.end('ok');
	});

	const cache = new Map();
	const storedCookies: string[] = [];
	const cookieJar = {
		getCookieString: async () => '',
		async setCookie(rawCookie: string) {
			storedCookies.push(rawCookie);
		},
	};

	await got({cache, cookieJar});
	const cachedResponse = await got({cache, cookieJar});

	assert.strictEqual(requests, 1);
	assert.strictEqual(cachedResponse.isFromCache, true);
	// Only a response that was not served from the cache may update the jar.
	assert.deepStrictEqual(storedCookies, ['session=value-1']);
});

test('a revalidated response does not re-apply Set-Cookie to the cookie jar', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		requests++;
		if (request.headers['if-none-match'] === '"v1"') {
			response.statusCode = 304;
			response.setHeader('set-cookie', 'session=value-2');
			response.end();
			return;
		}

		response.setHeader('cache-control', 'public, max-age=0');
		response.setHeader('etag', '"v1"');
		response.setHeader('set-cookie', 'session=value-1');
		response.end('ok');
	});

	const cache = new Map();
	const storedCookies: string[] = [];
	const cookieJar = {
		getCookieString: async () => '',
		async setCookie(rawCookie: string) {
			storedCookies.push(rawCookie);
		},
	};

	await got({cache, cookieJar});
	const revalidatedResponse = await got({cache, cookieJar});

	assert.strictEqual(requests, 2);
	assert.strictEqual(revalidatedResponse.isFromCache, true);
	// The cache layer marks a revalidated entry as cache-served like a stored hit, so its `set-cookie` does not reach the jar.
	assert.deepStrictEqual(storedCookies, ['session=value-1']);
});

test('a revalidation answered with a fresh response re-applies Set-Cookie to the cookie jar', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=0');
		response.setHeader('etag', '"v1"');
		response.setHeader('set-cookie', request.headers['if-none-match'] === '"v1"' ? 'session=value-2' : 'session=value-1');
		response.end('ok');
	});

	const cache = new Map();
	const storedCookies: string[] = [];
	const cookieJar = {
		getCookieString: async () => '',
		async setCookie(rawCookie: string) {
			storedCookies.push(rawCookie);
		},
	};

	await got({cache, cookieJar});
	const response = await got({cache, cookieJar});

	// The server ignored the conditional request, so the second response is a fresh 200, not a 304.
	assert.strictEqual(requests, 2);
	assert.strictEqual(response.isFromCache, false);
	assert.strictEqual(response.body, 'ok');
	// A fresh response is not cache-served, so it may update the jar.
	assert.deepStrictEqual(storedCookies, ['session=value-1', 'session=value-2']);
});
