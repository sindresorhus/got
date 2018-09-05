import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	let noStoreIndex = 0;
	s.on('/no-store', (request, response) => {
		response.setHeader('Cache-Control', 'public, no-cache, no-store');
		response.end(noStoreIndex.toString());
		noStoreIndex++;
	});

	let cacheIndex = 0;
	s.on('/cache', (request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(cacheIndex.toString());
		cacheIndex++;
	});

	let calledFirstError = false;
	s.on('/first-error', (request, response) => {
		if (calledFirstError) {
			response.end('ok');
			return;
		}

		calledFirstError = true;
		response.statusCode = 502;
		response.end('received 502');
	});

	let status301Index = 0;
	s.on('/301', (request, response) => {
		if (status301Index === 0) {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.setHeader('Location', `${s.url}/302`);
			response.statusCode = 301;
		}
		response.end();
		status301Index++;
	});

	let status302Index = 0;
	s.on('/302', (request, response) => {
		if (status302Index === 0) {
			response.setHeader('Cache-Control', 'public, max-age=60');
			response.setHeader('Location', `${s.url}/cache`);
			response.statusCode = 302;
		}
		response.end();
		status302Index++;
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('Non cacheable responses are not cached', async t => {
	const endpoint = '/no-store';
	const cache = new Map();

	const firstResponseInt = Number((await got(s.url + endpoint, {cache})).body);
	const secondResponseInt = Number((await got(s.url + endpoint, {cache})).body);

	t.is(cache.size, 0);
	t.true(firstResponseInt < secondResponseInt);
});

test('Cacheable responses are cached', async t => {
	const endpoint = '/cache';
	const cache = new Map();

	const firstResponse = await got(s.url + endpoint, {cache});
	const secondResponse = await got(s.url + endpoint, {cache});

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('Cached response is re-encoded to current encoding option', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const firstEncoding = 'base64';
	const secondEncoding = 'hex';

	const firstResponse = await got(s.url + endpoint, {cache, encoding: firstEncoding});
	const secondResponse = await got(s.url + endpoint, {cache, encoding: secondEncoding});

	const expectedSecondResponseBody = Buffer.from(firstResponse.body, firstEncoding).toString(secondEncoding);

	t.is(cache.size, 1);
	t.is(secondResponse.body, expectedSecondResponseBody);
});

test('Redirects are cached and re-used internally', async t => {
	const endpoint = '/301';
	const cache = new Map();

	const firstResponse = await got(s.url + endpoint, {cache});
	const secondResponse = await got(s.url + endpoint, {cache});

	t.is(cache.size, 3);
	t.is(firstResponse.body, secondResponse.body);
});

test('Cache error throws got.CacheError', async t => {
	const endpoint = '/no-store';
	const cache = {};

	const error = await t.throwsAsync(got(s.url + endpoint, {cache}));
	t.is(error.name, 'CacheError');
});

test('doesn\'t cache response when received HTTP error', async t => {
	const endpoint = '/first-error';
	const cache = new Map();

	const response = await got(s.url + endpoint, {cache, throwHttpErrors: false});
	t.is(response.statusCode, 200);
	t.deepEqual(response.body, 'ok');
});
