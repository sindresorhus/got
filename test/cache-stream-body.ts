import {Readable} from 'node:stream';
import test from 'ava';
import getStream from 'get-stream';
import withServer from './helpers/with-server.js';

test('native FormData uploads work with cache enabled', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});

	const form = new FormData();
	form.set('field', 'form payload');

	const withoutCache = await got.post({body: form});
	t.true(withoutCache.body.includes('form payload'));

	const cache = new Map();
	const withCache = await got.post({body: form, cache});
	t.true(withCache.body.includes('name="field"'));
	t.true(withCache.body.includes('form payload'));
	t.false(withCache.isFromCache);
	t.is(cache.size, 0);
});

test('Web stream uploads work with cache enabled', withServer, async (t, server, got) => {
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

	t.is(response.body, 'streamed payload');
	t.false(response.isFromCache);
	t.is(cache.size, 0);
});

test('Node stream uploads keep bypassing the cache', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(await getStream(request));
	});

	const cache = new Map();
	const response = await got.post({
		body: Readable.from(['streamed payload']),
		cache,
	});

	t.is(response.body, 'streamed payload');
	t.false(response.isFromCache);
	t.is(cache.size, 0);
});

test('string uploads remain cacheable', withServer, async (t, server, got) => {
	let requests = 0;
	server.post('/', (_request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('stored');
	});

	const cache = new Map();
	await got.post({body: 'form payload', cache});
	const response = await got.post({body: 'form payload', cache});

	t.is(response.body, 'stored');
	t.true(response.isFromCache);
	t.is(requests, 1);
	t.is(cache.size, 1);
});
