import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import {Readable as ReadableStream} from 'node:stream';
import {Agent} from 'node:http';
import {gzip} from 'node:zlib';
import process from 'node:process';
import test from 'ava';
import {pEvent} from 'p-event';
import getStream from 'get-stream';
import type {Handler} from 'express';
import nock from 'nock';
import CacheableLookup from 'cacheable-lookup';
import delay from 'delay';
import got, {CacheError, type Response} from '../source/index.js';
import withServer from './helpers/with-server.js';

const cacheEndpoint: Handler = (_request, response) => {
	response.setHeader('Cache-Control', 'public, max-age=60');
	response.end(Date.now().toString());
};

test('non-cacheable responses are not cached', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, no-cache, no-store');
		response.end(Date.now().toString());
	});

	const cache = new Map();

	const firstResponseInt = Number((await got({cache})).body);
	const secondResponseInt = Number((await got({cache})).body);

	t.is(cache.size, 0);
	t.true(firstResponseInt < secondResponseInt);
});

test('cacheable responses are cached', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({cache});
	const secondResponse = await got({cache});

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('cacheable responses to POST requests are cached', withServer, async (t, server, got) => {
	server.post('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({method: 'POST', body: 'test', cache});
	const secondResponse = await got({method: 'POST', body: 'test', cache});

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('non-cacheable responses to POST requests are not cached', withServer, async (t, server, got) => {
	server.post('/', cacheEndpoint);

	const cache = new Map();

	// POST requests with streams are not cached
	const body1 = ReadableStream.from(Buffer.from([1, 2, 3]));
	const body2 = ReadableStream.from(Buffer.from([1, 2, 3]));

	const firstResponseInt = Number((await got({method: 'POST', body: body1, cache})).body);
	const secondResponseInt = Number((await got({method: 'POST', body: body2, cache})).body);

	t.is(cache.size, 0);
	t.true(firstResponseInt < secondResponseInt);
});

test('cached response is re-encoded to current encoding option', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const firstEncoding = 'base64';
	const secondEncoding = 'hex';

	const firstResponse = await got({cache, encoding: firstEncoding});
	const secondResponse = await got({cache, encoding: secondEncoding});

	const expectedSecondResponseBody = Buffer.from(firstResponse.body, firstEncoding).toString(secondEncoding);

	t.is(cache.size, 1);
	t.is(secondResponse.body, expectedSecondResponseBody);
});

test('redirects are cached and re-used internally', withServer, async (t, server, got) => {
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

	t.is(cache.size, 3);
	t.is(a1.body, b1.body);
	t.is(a1.body, a2.body);
	t.is(b1.body, b2.body);
});

test('cached response has got options', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const options = {
		username: 'foo',
		cache,
	};

	await got(options);
	const secondResponse = await got(options);

	t.is(secondResponse.request.options.username, options.username);
});

test('cache error throws `CacheError`', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = {};

	// @ts-expect-error Error tests
	await t.throwsAsync(got({cache}), {
		instanceOf: CacheError,
		code: 'ERR_CACHE_ACCESS',
	});
});

test('doesn\'t cache response when received HTTP error', withServer, async (t, server, got) => {
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

	const {statusCode, body} = await got({url: '', cache, throwHttpErrors: false});
	t.is(statusCode, 200);
	t.is(body, 'ok');
});

test('DNS cache works', async t => {
	const instance = got.extend({
		dnsCache: true,
	});

	await t.notThrowsAsync(instance('https://example.com'));

	// @ts-expect-error Accessing private property
	t.is(instance.defaults.options.dnsCache!._cache.size, 1);
});

test('DNS cache works - CacheableLookup instance', async t => {
	const cache = new CacheableLookup();
	await t.notThrowsAsync(got('https://example.com', {dnsCache: cache}));

	t.is((cache as any)._cache.size, 1);
});

test('`isFromCache` stream property is undefined before the `response` event', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const stream = got.stream({cache});
	t.is(stream.isFromCache, undefined);

	await getStream(stream);
});

test('`isFromCache` stream property is false after the `response` event', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const stream = got.stream({cache});

	const response: Response = await pEvent(stream, 'response');
	t.is(response.isFromCache, false);
	t.is(stream.isFromCache, false);

	await getStream(stream);
});

test('`isFromCache` stream property is true if the response was cached', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	await getStream(got.stream({cache}));
	const stream = got.stream({cache});

	const response: Response = await pEvent(stream, 'response');
	t.is(response.isFromCache, true);
	t.is(stream.isFromCache, true);

	await getStream(stream);
});

test('can disable cache by extending the instance', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const instance = got.extend({cache});

	await getStream(instance.stream(''));
	const stream = instance.extend({cache: false}).stream('');

	const response: Response = await pEvent(stream, 'response');
	t.is(response.isFromCache, false);
	t.is(stream.isFromCache, false);

	await getStream(stream);
});

test('does not break POST requests', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		request.resume();
		response.end(JSON.stringify(request.headers));
	});

	const headers = await got.post('', {
		body: '',
		cache: new Map(),
	}).json<{'content-length': string}>();

	t.is(headers['content-length'], '0');
});

test('decompresses cached responses', withServer, async (t, server, got) => {
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
		await t.notThrowsAsync(got({
			cache,
			responseType: 'json',
			decompress: true,
			retry: {
				limit: 2,
			},
		}));
	}

	t.is(cache.size, 1);
});

test('can replace the instance\'s HTTP cache', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const secondCache = new Map();

	const instance = got.extend({
		mutableDefaults: true,
		cache,
	});

	await t.notThrowsAsync(instance(''));
	await t.notThrowsAsync(instance(''));

	instance.defaults.options.cache = secondCache;

	await t.notThrowsAsync(instance(''));
	await t.notThrowsAsync(instance(''));

	t.is(cache.size, 1);
	t.is(secondCache.size, 1);
});

test('does not hang on huge response', withServer, async (t, server, got) => {
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

	t.is(body.length, bufferSize * times);
});

test('cached response ETag', withServer, async (t, server, got) => {
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

	t.false(originalResponse.isFromCache);
	t.is(originalResponse.body, body);

	await delay(100); // Added small delay in order to wait the cache to be populated

	t.is(cache.size, 1);

	const cachedResponse = await got({cache});

	t.true(cachedResponse.isFromCache);
	t.is(cachedResponse.body, body);
});

// TODO: The test is flaky.
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

test('http-cache-semantics typings', t => {
	const instance = got.extend({
		cacheOptions: {
			shared: false,
		},
	});

	t.is(instance.defaults.options.cacheOptions.shared, false);
});

test('allows internal modifications', async t => {
	nock('http://example.com').get('/test').reply(401);
	nock('http://example.com').get('/test').reply(200, JSON.stringify({
		wat: ['123'],
	}));

	const client = got.extend({
		cache: new Map(),
		hooks: {
			afterResponse: [
				async (response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({});
					}

					return response;
				},
			],
		},
	});

	await t.notThrowsAsync(client.get('http://example.com/test'));
});

test('response.complete is true when using keepalive agent', withServer, async (t, server, got) => {
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

	t.true(first.complete);
});

test.failing('revalidated uncompressed responses are retrieved from cache', withServer, async (t, server, got) => {
	let revalidated = false;

	const payload = JSON.stringify([1]);

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === 'asdf') {
			revalidated = true;
			response.writeHead(304, {etag: 'asdf'});
			response.end();
		} else {
			response.writeHead(200, {
				etag: 'asdf',
				'cache-control': 'public, max-age=1, s-maxage=1',
				'content-type': 'application/json',
			});
			response.write(payload);
			response.end();
		}
	});

	t.timeout(5000);

	const client = got.extend({cache: new Map(), responseType: 'json'});

	await client('').then(response => {
		t.false(revalidated);
		t.deepEqual(response.body, [1]);
		t.true(response.complete);
	});

	// eslint-disable-next-line no-promise-executor-return
	await new Promise(resolve => setTimeout(resolve, 3000));

	console.log('max-age has expired, performing second request');

	await client('').then(response => {
		t.true(revalidated);
		t.deepEqual(response.body, [1]);
		t.true(response.complete); // Fails here.
	});
});

test.failing('revalidated compressed responses are retrieved from cache', withServer, async (t, server, got) => {
	let revalidated = false;

	const payload = JSON.stringify([1]);
	const compressed = await promisify(gzip)(payload);

	server.get('/', (request, response) => {
		if (request.headers['if-none-match'] === 'asdf') {
			revalidated = true;
			response.writeHead(304, {etag: 'asdf'});
			response.end();
		} else {
			response.writeHead(200, {
				etag: 'asdf',
				'cache-control': 'public, max-age=1, s-maxage=1',
				'content-type': 'application/json',
				'content-encoding': 'gzip',
			});
			response.write(compressed);
			response.end();
		}
	});

	t.timeout(5000);

	const client = got.extend({cache: new Map(), responseType: 'json'});

	await client('').then(response => {
		t.false(revalidated);
		t.deepEqual(response.body, [1]);
		t.true(response.complete);
	});

	// eslint-disable-next-line no-promise-executor-return
	await new Promise(resolve => setTimeout(resolve, 3000));

	console.log('max-age has expired, performing second request (but it will actually hang)');

	await client('').then(response => {
		t.true(revalidated);
		t.deepEqual(response.body, [1]);
		t.true(response.complete);
	});
});

// eslint-disable-next-line ava/no-skip-test -- Unreliable
test.skip('revalidated uncompressed responses from github are retrieved from cache', async t => {
	const client = got.extend({
		cache: new Map(),
		cacheOptions: {shared: false},
		responseType: 'json',
		headers: {
			'accept-encoding': 'identity',
			...(process.env.GITHUB_TOKEN ? {authorization: `token ${process.env.GITHUB_TOKEN}`} : {}),
		},
	});

	t.timeout(70_000);

	await client('https://api.github.com/repos/octocat/Spoon-Knife').then(response => {
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete);
	});

	// eslint-disable-next-line no-promise-executor-return
	await new Promise(resolve => setTimeout(resolve, 65_000));

	console.log('max-age has expired, performing second request');

	await client('https://api.github.com/repos/octocat/Spoon-Knife').then(response => {
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete); // Fails here.
	});
});

// eslint-disable-next-line ava/no-skip-test -- Unreliable
test.skip('revalidated compressed responses from github are retrieved from cache', async t => {
	const client = got.extend({
		cache: new Map(),
		cacheOptions: {shared: false},
		responseType: 'json',
		headers: process.env.GITHUB_TOKEN ? {authorization: `token ${process.env.GITHUB_TOKEN}`} : {},
	});

	t.timeout(70_000);

	await client('https://api.github.com/repos/octocat/Spoon-Knife').then(response => {
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete);
	});

	// eslint-disable-next-line no-promise-executor-return
	await new Promise(resolve => setTimeout(resolve, 65_000));

	console.log('max-age has expired, performing second request (but it will actually hang)');

	await client('https://api.github.com/repos/octocat/Spoon-Knife').then(response => {
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete);
	});
});
