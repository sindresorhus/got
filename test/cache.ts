import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {Agent} from 'node:http';
import {gzip} from 'node:zlib';
import process from 'node:process';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import type {Handler} from 'express';
import delay from 'delay';
import got, {CacheError, HTTPError, type Response} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import {onceValue} from './helpers/once-value.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

let cacheResponseCount = 0;

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

	const cache = {
		get() {
			return undefined;
		},
		set() {
			const error = new Error('Cache write failed') as NodeJS.ErrnoException;
			error.code = 'EACCES';
			throw error;
		},
		delete() {},
	} as any;

	await assert.rejects(got({cache}), errorMatching(CacheError, {code: 'ERR_CACHE_ACCESS'}));
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
