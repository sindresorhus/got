import test from 'ava';
import pEvent = require('p-event');
import getStream = require('get-stream');
import {Handler} from 'express';
import {Response} from '../source';
import withServer from './helpers/with-server';

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
	const firstResponse = await got('301', {cache});
	const secondResponse = await got('302', {cache});

	t.is(cache.size, 3);
	t.is(firstResponse.body, secondResponse.body);
});

test('cached response has got options', withServer, async (t, server, got) => {
	server.get('/', cacheEndpoint);

	const cache = new Map();
	const options = {
		username: 'foo',
		cache
	};

	await got(options);
	const secondResponse = await got(options);

	t.is(secondResponse.request.options.username, options.username);
});

test('cache error throws `got.CacheError`', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = {};

	// @ts-ignore Error tests
	await t.throwsAsync(got({cache}), got.CacheError);
});

test('doesn\'t cache response when received HTTP error', withServer, async (t, server, got) => {
	let calledFirstError = false;
	server.get('/', (_request, response) => {
		if (!calledFirstError) {
			response.end('ok');
			return;
		}

		calledFirstError = true;
		response.statusCode = 502;
		response.end('received 502');
	});

	const cache = new Map();

	const {statusCode, body} = await got({url: '', cache, throwHttpErrors: false});
	t.is(statusCode, 200);
	t.is(body, 'ok');
});

test('DNS cache works', withServer, async (t, _server, got) => {
	const map = new Map();
	await t.notThrowsAsync(got('https://example.com', {dnsCache: map, prefixUrl: ''}));

	t.is(map.size, 1);
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
