import test from 'ava';
import withServer from './helpers/with-server';

const cacheEndpoint = (request, response) => {
	response.setHeader('Cache-Control', 'public, max-age=60');
	response.end(Date.now().toString());
};

test('non-cacheable responses are not cached', withServer, async (t, server, got) => {
	server.get('/no-store', (request, response) => {
		response.setHeader('Cache-Control', 'public, no-cache, no-store');
		response.end(Date.now().toString());
	});

	const cache = new Map();

	const firstResponseInt = Number((await got('no-store', {cache})).body);
	const secondResponseInt = Number((await got('no-store', {cache})).body);

	t.is(cache.size, 0);
	t.true(firstResponseInt < secondResponseInt);
});

test('cacheable responses are cached', withServer, async (t, server, got) => {
	server.get('/cache', cacheEndpoint);

	const cache = new Map();

	const firstResponse = await got('cache', {cache});
	const secondResponse = await got('cache', {cache});

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('cached response is re-encoded to current encoding option', withServer, async (t, server, got) => {
	server.get('/cache', cacheEndpoint);

	const cache = new Map();
	const firstEncoding = 'base64';
	const secondEncoding = 'hex';

	const firstResponse = await got('cache', {cache, encoding: firstEncoding});
	const secondResponse = await got('cache', {cache, encoding: secondEncoding});

	const expectedSecondResponseBody = Buffer.from(firstResponse.body, firstEncoding).toString(secondEncoding);

	t.is(cache.size, 1);
	t.is(secondResponse.body, expectedSecondResponseBody);
});

test('redirects are cached and re-used internally', withServer, async (t, server, got) => {
	let status301Index = 0;
	server.get('/301', (request, response) => {
		if (status301Index === 0) {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.setHeader('Location', `${server.url}/302`);
			response.statusCode = 301;
		}

		response.end();
		status301Index++;
	});

	let status302Index = 0;
	server.get('/302', (request, response) => {
		if (status302Index === 0) {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.setHeader('Location', `${server.url}/cache`);
			response.statusCode = 302;
		}

		response.end();
		status302Index++;
	});

	server.get('/cache', cacheEndpoint);

	const cache = new Map();
	const firstResponse = await got('301', {cache});
	const secondResponse = await got('302', {cache});

	t.is(cache.size, 3);
	t.is(firstResponse.body, secondResponse.body);
});

test('cached response has got options', withServer, async (t, server, got) => {
	server.get('/cache', cacheEndpoint);

	const cache = new Map();
	const options = {
		url: 'cache',
		auth: 'foo:bar',
		cache
	};

	await got(options);
	const secondResponse = await got(options);

	t.is(secondResponse.request.gotOptions.auth, options.auth);
});

test('cache error throws `got.CacheError`', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	const cache = {};

	await t.throwsAsync(() => got({cache}), got.CacheError);
});

test('doesn\'t cache response when received HTTP error', withServer, async (t, server, got) => {
	let calledFirstError = false;
	server.get('/first-error', (request, response) => {
		if (calledFirstError) {
			response.end('ok');
			return;
		}

		calledFirstError = true;
		response.statusCode = 502;
		response.end('received 502');
	});

	const cache = new Map();

	const {statusCode, body} = await got('first-error', {cache, throwHttpErrors: false});
	t.is(statusCode, 200);
	t.deepEqual(body, 'ok');
});

test('DNS cache works', withServer, async (t, server, got) => {
	const map = new Map();
	await t.notThrowsAsync(() => got('https://example.com', {dnsCache: map}));

	t.is(map.size, 1);
});
