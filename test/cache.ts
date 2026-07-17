import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import {Readable as ReadableStream} from 'node:stream';
import {EventEmitter} from 'node:events';
import {Agent} from 'node:http';
import {gzip} from 'node:zlib';
import process from 'node:process';
import test from 'ava';
import Keyv from 'keyv';
import {pEvent} from 'p-event';
import getStream from 'get-stream';
import type {Handler} from 'express';
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

test('successful unsafe requests invalidate cached GET responses', withServer, async (t, server, got) => {
	let value = 'before';
	let getRequestCount = 0;
	server.get('/', (_request, response) => {
		getRequestCount++;
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(value);
	});
	server.post('/', (_request, response) => {
		value = 'after';
		response.status(204).end();
	});

	const cache = new Map();
	const initialResponse = await got({cache});
	const cachedResponse = await got({cache});
	await got.post({cache});
	const updatedResponse = await got({cache});

	t.is(initialResponse.body, 'before');
	t.true(cachedResponse.isFromCache);
	t.is(updatedResponse.body, 'after');
	t.false(updatedResponse.isFromCache);
	t.is(getRequestCount, 2);
});

test('successful unknown unsafe methods invalidate cached GET and HEAD responses', withServer, async (t, server, got) => {
	let value = 'before';
	let getRequestCount = 0;
	let headRequestCount = 0;
	server.all('/', (request, response) => {
		switch (request.method) {
			case 'GET': {
				getRequestCount++;
				response.setHeader('Cache-Control', 'public, max-age=60');
				response.end(value);
				break;
			}

			case 'HEAD': {
				headRequestCount++;
				response.setHeader('Cache-Control', 'public, max-age=60');
				response.setHeader('X-Value', value);
				response.end();
				break;
			}

			default: {
				value = 'after';
				response.status(204).end();
			}
		}
	});

	const cache = new Map();
	await got({cache});
	await got.head({cache});
	t.true((await got({cache})).isFromCache);
	t.true((await got.head({cache})).isFromCache);

	// The runtime accepts arbitrary HTTP methods even though the public convenience type enumerates Got's built-in methods.
	await got({method: 'PURGE' as never, cache});

	const updatedGetResponse = await got({cache});
	const updatedHeadResponse = await got.head({cache});
	t.is(updatedGetResponse.body, 'after');
	t.is(updatedHeadResponse.headers['x-value'], 'after');
	t.false(updatedGetResponse.isFromCache);
	t.false(updatedHeadResponse.isFromCache);
	t.is(getRequestCount, 2);
	t.is(headRequestCount, 2);
});

test('in-flight GET requests cannot repopulate stale cache entries after invalidation', withServer, async (t, server, got) => {
	let value = 'before';
	let getRequestCount = 0;
	let notifyGetStarted!: () => void;
	const getStarted = new Promise<void>(resolve => {
		notifyGetStarted = resolve;
	});
	let releaseGet!: () => void;
	const getReleased = new Promise<void>(resolve => {
		releaseGet = resolve;
	});
	server.get('/', async (_request, response) => {
		getRequestCount++;
		const responseValue = value;
		notifyGetStarted();
		await getReleased;
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(responseValue);
	});
	server.post('/', (_request, response) => {
		value = 'after';
		response.status(204).end();
	});

	const cache = new Map();
	const inFlightResponsePromise = got({cache});
	await getStarted;
	await got.post({cache});
	releaseGet();

	const inFlightResponse = await inFlightResponsePromise;
	const updatedResponse = await got({cache});
	t.is(inFlightResponse.body, 'before');
	t.is(updatedResponse.body, 'after');
	t.false(updatedResponse.isFromCache);
	t.is(getRequestCount, 2);
});

test('in-flight revalidation cannot repopulate stale cache entries after invalidation', withServer, async (t, server, got) => {
	let value = 'before';
	let getRequestCount = 0;
	let notifyRevalidationStarted!: () => void;
	const revalidationStarted = new Promise<void>(resolve => {
		notifyRevalidationStarted = resolve;
	});
	let releaseRevalidation!: () => void;
	const revalidationReleased = new Promise<void>(resolve => {
		releaseRevalidation = resolve;
	});
	server.get('/', async (request, response) => {
		getRequestCount++;
		response.setHeader('Cache-Control', 'public, max-age=0');
		response.setHeader('ETag', '"before"');

		if (request.headers['if-none-match']) {
			notifyRevalidationStarted();
			await revalidationReleased;
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.status(304).end();
			return;
		}

		response.end(value);
	});
	server.post('/', (_request, response) => {
		value = 'after';
		response.status(204).end();
	});

	const cache = new Map();
	await got({cache});
	const revalidationPromise = got({cache});
	await revalidationStarted;
	await got.post({cache});
	releaseRevalidation();
	await revalidationPromise;

	const updatedResponse = await got({cache});
	t.is(updatedResponse.body, 'after');
	t.false(updatedResponse.isFromCache);
	t.is(getRequestCount, 3);
});

test('cache write context does not leak into unsafe requests started by response hooks', withServer, async (t, server, got) => {
	let postRequestCount = 0;
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end('ok');
	});
	server.post('/', (_request, response) => {
		postRequestCount++;
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end('posted');
	});

	const cache = new Map();
	await got({
		cache,
		hooks: {
			afterResponse: [
				async response => {
					await got.post({
						cache,
						body: 'payload',
					});
					return response;
				},
			],
		},
	});

	const cachedPostResponse = await got.post({
		cache,
		body: 'payload',
	});
	t.true(cachedPostResponse.isFromCache);
	t.is(postRequestCount, 1);
});

test('PUT, PATCH, and DELETE invalidate cached GET responses', withServer, async (t, server, got) => {
	const methods = ['PUT', 'PATCH', 'DELETE'] as const;
	const values = new Map(methods.map(method => [method, 'before']));
	const getRequestCounts = new Map(methods.map(method => [method, 0]));
	server.all('/:method', (request, response) => {
		const method = request.params.method.toUpperCase() as typeof methods[number];
		if (request.method === 'GET') {
			getRequestCounts.set(method, getRequestCounts.get(method)! + 1);
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.end(values.get(method));
			return;
		}

		values.set(method, 'after');
		response.status(204).end();
	});

	const cache = new Map();
	for (const method of methods) {
		const path = method.toLowerCase();
		// eslint-disable-next-line no-await-in-loop
		await got(path, {cache});
		// eslint-disable-next-line no-await-in-loop
		const cachedResponse = await got(path, {cache});
		// eslint-disable-next-line no-await-in-loop
		await got(path, {method, cache});
		// eslint-disable-next-line no-await-in-loop
		const updatedResponse = await got(path, {cache});

		t.true(cachedResponse.isFromCache);
		t.is(updatedResponse.body, 'after');
		t.false(updatedResponse.isFromCache);
		t.is(getRequestCounts.get(method), 2);
	}
});

test('3xx responses to unsafe requests invalidate cached GET responses', withServer, async (t, server, got) => {
	let value = 'before';
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(value);
	});
	server.post('/', (_request, response) => {
		value = 'after';
		response.status(302).end();
	});

	const cache = new Map();
	await got({cache});
	const cachedResponse = await got({cache});
	await got.post({cache, followRedirect: false});
	const updatedResponse = await got({cache});

	t.true(cachedResponse.isFromCache);
	t.is(updatedResponse.body, 'after');
	t.false(updatedResponse.isFromCache);
});

test('error responses to unsafe requests do not invalidate cached GET responses', withServer, async (t, server, got) => {
	const statuses = [400, 500];
	server.all('/:statusCode', (request, response) => {
		if (request.method === 'GET') {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.end('cached');
			return;
		}

		response.status(Number(request.params.statusCode)).end();
	});

	const cache = new Map();
	await Promise.all(statuses.map(async statusCode => {
		const path = String(statusCode);
		await got(path, {cache});
		await got.post(path, {cache, throwHttpErrors: false});
		const cachedResponse = await got(path, {cache});

		t.is(cachedResponse.body, 'cached');
		t.true(cachedResponse.isFromCache);
	}));
});

test('safe requests do not invalidate cached GET responses', withServer, async (t, server, got) => {
	server.all('/', (request, response) => {
		if (request.method === 'GET') {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.end('cached');
			return;
		}

		response.status(204).end();
	});

	const cache = new Map();
	await got({cache});
	await got({method: 'OPTIONS', cache});
	await got({method: 'TRACE', cache});
	await got.query({cache, json: {query: true}});
	const cachedResponse = await got({cache});

	t.is(cachedResponse.body, 'cached');
	t.true(cachedResponse.isFromCache);
});

test('unsafe requests invalidate normalized private Keyv cache entries with and without key prefixes', withServer, async (t, server, got) => {
	const values = new Map([
		['prefixed', 'before'],
		['unprefixed', 'before'],
	]);
	server.all('/:prefixing', (request, response) => {
		const {prefixing} = request.params;
		if (request.method === 'GET') {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.end(values.get(prefixing));
			return;
		}

		values.set(prefixing, 'after');
		response.status(204).end();
	});

	await Promise.all([true, false].map(async useKeyPrefix => {
		const cache = new Keyv({namespace: 'custom', useKeyPrefix});
		let deletionCount = 0;
		cache.hooks.addHandler('postDelete', () => {
			deletionCount++;
		});
		const privateOptions = {
			cache,
			cacheOptions: {shared: false},
		};
		const prefixing = useKeyPrefix ? 'prefixed' : 'unprefixed';
		const url = `${prefixing}?b=2&utm_source=test&a=1#fragment`;
		await got(url, {cache});
		await got(url, privateOptions);
		const cachedResponse = await got(url, privateOptions);
		await got.post(url, privateOptions);
		const updatedResponse = await got(url, privateOptions);
		const sharedResponse = await got(url, {cache});

		t.true(cachedResponse.isFromCache);
		t.is(updatedResponse.body, 'after');
		t.false(updatedResponse.isFromCache);
		t.is(sharedResponse.body, 'before');
		t.true(sharedResponse.isFromCache);
		t.is(deletionCount, 2);
	}));
});

test('successful unsafe requests invalidate cached HEAD responses', withServer, async (t, server, got) => {
	let headRequestCount = 0;
	server.head('/', (_request, response) => {
		headRequestCount++;
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end();
	});
	server.post('/', (_request, response) => {
		response.status(204).end();
	});

	const cache = new Map();
	await got.head({cache});
	const cachedResponse = await got.head({cache});
	await got.post({cache});
	const updatedResponse = await got.head({cache});

	t.true(cachedResponse.isFromCache);
	t.false(updatedResponse.isFromCache);
	t.is(headRequestCount, 2);
});

test('cache invalidation errors use Got\'s `CacheError`', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);
	server.post('/', (_request, response) => {
		response.status(204).end();
	});

	const storage = new Map();
	let shouldFailDeletion = false;
	const attemptedDeletions: unknown[] = [];
	const cache = {
		get(key: unknown) {
			return storage.get(key);
		},
		set(key: unknown, value: unknown) {
			return storage.set(key, value);
		},
		delete(key: unknown) {
			if (shouldFailDeletion) {
				attemptedDeletions.push(key);
				throw new Error('Cache invalidation failed');
			}

			return storage.delete(key);
		},
		clear() {
			storage.clear();
		},
	};

	await got({cache: cache as any});
	shouldFailDeletion = true;
	let beforeCacheHookCalled = false;

	await t.throwsAsync(got.post({
		cache: cache as any,
		hooks: {
			beforeCache: [
				() => {
					beforeCacheHookCalled = true;
					throw new Error('Hook error');
				},
			],
		},
	}), {
		instanceOf: CacheError,
		code: 'ERR_CACHE_ACCESS',
	});
	t.false(beforeCacheHookCalled);
	t.is(attemptedDeletions.length, 2);
});

test('Keyv store invalidation errors use Got\'s `CacheError`', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);
	server.post('/', (_request, response) => {
		response.status(204).end();
	});

	const storage = new Map();
	let shouldFailDeletion = false;
	const store = {
		get(key: unknown) {
			return storage.get(key);
		},
		set(key: unknown, value: unknown) {
			return storage.set(key, value);
		},
		delete(key: unknown) {
			if (shouldFailDeletion) {
				throw new Error('Cache invalidation failed');
			}

			return storage.delete(key);
		},
		clear() {
			storage.clear();
		},
	};
	const cache = new Keyv({store: store as any, stats: true});
	await got({cache});
	const initialErrorListenerCount = cache.listeners('error').length;
	const initialDeletionCount = cache.stats.deletes;
	const deletionResults: boolean[] = [];
	cache.hooks.addHandler('postDelete', ({value}: {value: boolean}) => {
		deletionResults.push(value);
	});
	shouldFailDeletion = true;

	await t.throwsAsync(got.post({cache}), {
		instanceOf: CacheError,
		code: 'ERR_CACHE_ACCESS',
	});
	t.is(cache.listeners('error').length, initialErrorListenerCount);
	t.is(cache.stats.deletes, initialDeletionCount + 2);
	t.deepEqual(deletionResults, [false, false]);
});

test('Keyv cache setup does not add listeners to the underlying store', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const storage = new Map();
	const store = new EventEmitter();
	Object.assign(store, {
		get(key: unknown) {
			return storage.get(key);
		},
		set(key: unknown, value: unknown) {
			return storage.set(key, value);
		},
		delete(key: unknown) {
			return storage.delete(key);
		},
		clear() {
			storage.clear();
		},
	});
	const cache = new Keyv({store: store as any});
	const initialListenerCount = store.listenerCount('error');

	await got({cache});

	t.is(store.listenerCount('error'), initialListenerCount);
});

test('concurrent cache invalidation errors affect only the failing request', withServer, async (t, server, got) => {
	let markFailingResponseSent: () => void;
	const failingResponseSent = new Promise<void>(resolve => {
		markFailingResponseSent = resolve;
	});
	server.all('/:outcome', (request, response) => {
		if (request.method === 'GET') {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.end(request.params.outcome);
			return;
		}

		if (request.params.outcome === 'failing') {
			markFailingResponseSent();
		}

		response.status(204).end();
	});

	const storage = new Map();
	let coordinateDeletions = false;
	let shouldFailDeletion = false;
	let shouldFailSet = false;
	let markSuccessfulDeletionStarted: () => void;
	const successfulDeletionStarted = new Promise<void>(resolve => {
		markSuccessfulDeletionStarted = resolve;
	});
	let markFailingDeletionStarted: () => void;
	const failingDeletionStarted = new Promise<void>(resolve => {
		markFailingDeletionStarted = resolve;
	});
	let releaseSuccessfulDeletion = (): void => {};
	const successfulDeletionReleased = new Promise<void>(resolve => {
		releaseSuccessfulDeletion = resolve;
	});
	const store = {
		get(key: unknown) {
			return storage.get(key);
		},
		set(key: unknown, value: unknown) {
			if (shouldFailSet) {
				throw new Error('Unrelated cache write failed');
			}

			return storage.set(key, value);
		},
		async delete(key: unknown) {
			const shouldFailCurrentDeletion = shouldFailDeletion;
			if (coordinateDeletions && String(key).includes('/successful')) {
				markSuccessfulDeletionStarted();
				await successfulDeletionReleased;
			}

			if (shouldFailCurrentDeletion) {
				markFailingDeletionStarted();
				throw new Error('Cache invalidation failed');
			}

			return storage.delete(key);
		},
		clear() {
			storage.clear();
		},
	};
	const successfulCache = new Keyv({store: store as any});
	const failingCache = new Keyv({store: store as any});
	const privateOptions = {
		cache: successfulCache,
		cacheOptions: {shared: false},
	};

	await Promise.all([
		got('successful', privateOptions),
		got('failing', {cache: failingCache}),
	]);
	coordinateDeletions = true;

	const successfulRequest = t.notThrowsAsync(got.post('successful', privateOptions));
	await successfulDeletionStarted;
	shouldFailSet = true;
	await successfulCache.set('unrelated', 'value');
	shouldFailSet = false;
	shouldFailDeletion = true;
	const failingRequest = t.throwsAsync(got.post('failing', {cache: failingCache}), {
		instanceOf: CacheError,
	});
	await failingResponseSent;
	await failingDeletionStarted;
	releaseSuccessfulDeletion();
	await Promise.all([successfulRequest, failingRequest]);
});

test('custom adapters named Keyv are cached normally', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	class Keyv extends Map<string, string> {
		override set(key: string, value: string) {
			if (typeof value !== 'string') {
				throw new TypeError('Expected a serialized cache value');
			}

			return super.set(key, value);
		}
	}

	const cache = new Keyv();
	const firstResponse = await got({cache: cache as any});
	const secondResponse = await got({cache: cache as any});

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
	t.true(secondResponse.isFromCache);
});

test('private and shared cache contexts are isolated', withServer, async (t, server, got) => {
	let requestCount = 0;
	server.get('/', (request, response) => {
		requestCount++;
		response.setHeader('Cache-Control', 'private, max-age=60');
		response.end(request.headers.authorization === 'Bearer user-a' ? 'user-a' : 'user-b');
	});

	const cache = new Map();
	const privateResponse = await got({
		cache,
		cacheOptions: {shared: false},
		headers: {authorization: 'Bearer user-a'},
	});
	const privateCachedResponse = await got({
		cache,
		cacheOptions: {shared: false},
		headers: {authorization: 'Bearer user-a'},
	});
	const sharedResponse = await got({
		cache,
		headers: {authorization: 'Bearer user-b'},
	});

	t.is(privateResponse.body, 'user-a');
	t.true(privateCachedResponse.isFromCache);
	t.is(sharedResponse.body, 'user-b');
	t.is(requestCount, 2);
});

test('Keyv isolates shared and private cache contexts in reverse order', withServer, async (t, server, got) => {
	let requestCount = 0;
	server.get('/', (request, response) => {
		requestCount++;
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(request.headers.authorization === 'Bearer user-a' ? 'user-a' : 'user-b');
	});

	const storage = new Map();
	const cache = new Keyv({store: storage, namespace: 'custom'});
	const sharedResponse = await got({
		cache,
		headers: {authorization: 'Bearer user-b'},
	});
	const sharedCachedResponse = await got({
		cache,
		headers: {authorization: 'Bearer user-b'},
	});
	const privateResponse = await got({
		cache,
		cacheOptions: {shared: false},
		headers: {authorization: 'Bearer user-a'},
	});
	const privateCachedResponse = await got({
		cache,
		cacheOptions: {shared: false},
		headers: {authorization: 'Bearer user-a'},
	});

	t.is(sharedResponse.body, 'user-b');
	t.true(sharedCachedResponse.isFromCache);
	t.is(privateResponse.body, 'user-a');
	t.true(privateCachedResponse.isFromCache);
	t.is(requestCount, 2);
	t.true([...storage.keys()].every(key => typeof key === 'string' && key.startsWith('custom:')));
});

test('cacheable responses to POST requests are cached', withServer, async (t, server, got) => {
	server.post('/', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got({method: 'POST', body: 'test', cache});
	const secondResponse = await got({method: 'POST', body: 'test', cache});

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('QUERY responses are not cached', withServer, async (t, server, got) => {
	let responses = 0;
	server.all('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end((++responses).toString());
	});

	const cache = new Map();

	const firstResponse = await got.query({json: {query: true}, cache});
	const secondResponse = await got.query({json: {query: true}, cache});

	t.is(cache.size, 0);
	t.is(firstResponse.body, '1');
	t.is(secondResponse.body, '2');
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

test('Keyv `throwOnErrors` is preserved', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('ok');
	});

	const cache = new Keyv({
		store: {
			get() {
				const error = new Error('Cache read failed') as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			},
			set() {},
			delete() {
				return true;
			},
			clear() {},
		} as any,
		throwOnErrors: true,
	});

	await t.throwsAsync(got({cache}), {
		instanceOf: CacheError,
		code: 'ERR_CACHE_ACCESS',
	});
});

test('cache adapter error events are propagated', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = new EventEmitter();
	Object.assign(cache, {
		get() {
			cache.emit('error', new Error('Cache read failed'));
			return undefined;
		},
		set() {},
		delete() {},
		clear() {},
	});

	await t.throwsAsync(got({cache: cache as any}), {
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

	const {statusCode, body} = await got('', {cache, throwHttpErrors: false});
	t.is(statusCode, 200);
	t.is(body, 'ok');
});

test('cache should work with http2', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const instance = got.extend({
		cache: true,
		http2: true,
	});

	await t.notThrowsAsync(instance(''));
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

	const response: Response = await pEvent(stream, 'response') as Response;
	t.false(response.isFromCache);
	t.false(stream.isFromCache);

	await getStream(stream);
});

test('`isFromCache` stream property is true if the response was cached', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	await getStream(got.stream({cache}));
	const stream = got.stream({cache});

	const response: Response = await pEvent(stream, 'response') as Response;
	t.true(response.isFromCache);
	t.true(stream.isFromCache);

	await getStream(stream);
});

test('can disable cache by extending the instance', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const instance = got.extend({cache});

	await getStream(instance.stream(''));
	const stream = instance.extend({cache: false}).stream('');

	const response: Response = await pEvent(stream, 'response') as Response;
	t.false(response.isFromCache);
	t.false(stream.isFromCache);

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

test('http-cache-semantics typings', t => {
	const instance = got.extend({
		cacheOptions: {
			shared: false,
		},
	});

	t.false(instance.defaults.options.cacheOptions.shared);
});

test('allows internal modifications', withServer, async (t, server, got) => {
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
				async (response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({});
					}

					return response;
				},
			],
		},
	});

	await t.notThrowsAsync(client.get('test'));
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

test('revalidated uncompressed responses are retrieved from cache', withServer, async (t, server, got) => {
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

	const firstResponse = (await client('')) as unknown as Response<number[]>;
	t.false(revalidated);
	t.deepEqual(firstResponse.body, [1]);
	t.true(firstResponse.complete);

	await new Promise<void>(resolve => {
		setTimeout(resolve, 3000);
	});

	console.log('max-age has expired, performing second request');

	const secondResponse = (await client('')) as unknown as Response<number[]>;
	t.true(revalidated);
	t.deepEqual(secondResponse.body, [1]);
	t.true(secondResponse.complete); // Fails here.
});

test('revalidated compressed responses are retrieved from cache', withServer, async (t, server, got) => {
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

	const firstResponse = (await client('')) as unknown as Response<number[]>;
	t.false(revalidated);
	t.deepEqual(firstResponse.body, [1]);
	t.true(firstResponse.complete);

	await new Promise<void>(resolve => {
		setTimeout(resolve, 3000);
	});

	console.log('max-age has expired, performing second request (but it will actually hang)');

	const secondResponse = (await client('')) as unknown as Response<number[]>;
	t.true(revalidated);
	t.deepEqual(secondResponse.body, [1]);
	t.true(secondResponse.complete);
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

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete);
	}

	await new Promise<void>(resolve => {
		setTimeout(resolve, 65_000);
	});

	console.log('max-age has expired, performing second request');

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete); // Fails here.
	}
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

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete);
	}

	await new Promise<void>(resolve => {
		setTimeout(resolve, 65_000);
	});

	console.log('max-age has expired, performing second request (but it will actually hang)');

	{
		const response = await client('https://api.github.com/repos/octocat/Spoon-Knife');
		t.is((response.body as any).name, 'Spoon-Knife');
		t.true(response.complete);
	}
});

test('QuickLRU works as cache adapter (auto-wrapped)', withServer, async (t, server, got) => {
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

	t.is(firstResponse.body, secondResponse.body);
	t.false(firstResponse.isFromCache);
	t.true(secondResponse.isFromCache);
	t.is(cache.size, 1);
});

test('beforeCache hook: returning false prevents caching', withServer, async (t, server, got) => {
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

	t.is(cache.size, 0);
	t.not(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: returning void uses default caching', withServer, async (t, server, got) => {
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

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: conditionally prevent caching based on status code', withServer, async (t, server, got) => {
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

	t.is(cache.size, 1);
});

test('beforeCache hook: modify cache-control headers', withServer, async (t, server, got) => {
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

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: multiple hooks are executed in order', withServer, async (t, server, got) => {
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
					t.is(response.headers['x-hook-1'], 'executed');
				},
			],
		},
	});

	t.deepEqual(order, [1, 2]);
	t.is(cache.size, 1);
});

test('beforeCache hook: first hook returning false skips remaining hooks', withServer, async (t, server, got) => {
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

	t.false(secondHookCalled);
	t.is(cache.size, 0);
});

test('beforeCache hook: not called when cache option is disabled', withServer, async (t, server, got) => {
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

	t.false(hookCalled);
});

test('beforeCache hook: works with extended instances', withServer, async (t, server, got) => {
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

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('beforeCache hook: errors are propagated', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();

	const error = await t.throwsAsync(got({
		cache,
		hooks: {
			beforeCache: [
				() => {
					throw new Error('Hook error message');
				},
			],
		},
	}));

	t.is(error?.message, 'Hook error message');
});

test('beforeCache hook: returning undefined caches the original response correctly', withServer, async (t, server, got) => {
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
	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
	t.false(firstResponse.isFromCache);
	t.true(secondResponse.isFromCache);
});

test('beforeCache hook: mixed hook results work correctly', withServer, async (t, server, got) => {
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

	t.is(cache.size, 1);
	t.false(firstResponse.isFromCache);
	t.true(secondResponse.isFromCache);
	// The cached response should have the custom header from the hook that returned
	t.is(secondResponse.headers['x-custom'], 'cached');
	// Both mutations are included because mutations work directly
	t.is(secondResponse.headers['x-ignored'], 'ignored');
});

test('beforeCache hook: response body is correctly cached when hook returns undefined', withServer, async (t, server, got) => {
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
	t.is(firstResponse.body, 'Response 1');
	t.is(secondResponse.body, 'Response 1'); // Same body from cache
	t.is(requestCount, 1); // Only one actual request was made
	t.true(secondResponse.isFromCache);
});
