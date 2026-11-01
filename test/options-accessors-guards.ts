import assert from 'node:assert/strict';
import {Options} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('Options normalizes URL, prefix and cache inputs on construction and direct assignment', _t => {
	const options = new Options('users', {prefixUrl: new URL('https://example.com/api/'), cache: true});
	assert.ok(options.url instanceof URL);
	assert.strictEqual(options.url.href, 'https://example.com/api/users');
	assert.strictEqual(options.prefixUrl, 'https://example.com/api/');
	assert.ok(options.cache instanceof Map);
	options.prefixUrl = new URL('https://example.com/v2/');
	assert.strictEqual(options.prefixUrl, 'https://example.com/v2/');
	assert.strictEqual(options.url.href, 'https://example.com/v2/users');
	options.url = 'https://example.com/v2/final';
	assert.ok(options.url instanceof URL);
	assert.strictEqual(options.url.pathname, '/v2/final');
	options.cache = false;
	const disabledCache = options.cache;
	assert.strictEqual(disabledCache, undefined);
	options.url = undefined;
	assert.strictEqual(options.url, undefined);
	options.merge({prefixUrl: new URL('https://example.org/api/'), cache: true});
	options.url = 'next';
	assert.ok(options.url instanceof URL);
	assert.strictEqual(options.url.href, 'https://example.org/api/next');
	assert.strictEqual(options.prefixUrl, 'https://example.org/api/');
	assert.ok(options.cache instanceof Map);
	options.cache = 'redis://example.invalid';
	assert.strictEqual(options.cache, 'redis://example.invalid');
});

test('handler options retain string and URL writes while exposing normalized values', withServer, async (_t, server, got) => {
	server.get('/v2/final', (_request, response) => {
		response.end('normalized');
	});
	let handlers = 0;
	const client = got.extend({
		prefixUrl: new URL(server.url),
		cache: true,
		handlers: [(options, next) => {
			handlers++;
			assert.ok(options.url instanceof URL);
			assert.strictEqual(options.url.pathname, '/original');
			assert.strictEqual(options.prefixUrl, `${server.url}/`);
			assert.ok(options.cache instanceof Map);
			options.prefixUrl = new URL(`${server.url}/v2/`);
			options.url = 'final';
			options.cache = false;
			assert.ok(options.url instanceof URL);
			assert.strictEqual(options.cache, undefined);
			return next(options);
		}],
	});
	assert.strictEqual(await client('original').text(), 'normalized');
	assert.strictEqual(handlers, 1);
});

test('URL prefixes and boolean cache overrides remain accepted through instance extension', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/cached', (_request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(String(requests));
	});
	const client = got.extend({prefixUrl: new URL(server.url), cache: true});
	assert.strictEqual((await client('cached')).body, '1');
	const cached = await client('cached');
	assert.strictEqual(cached.body, '1');
	assert.strictEqual(cached.isFromCache, true);
	assert.strictEqual(requests, 1);
	const uncached = client.extend({cache: false});
	assert.strictEqual((await uncached('cached')).body, '2');
	assert.strictEqual(requests, 2);
});
