import test from 'ava';
import getStream from 'get-stream';
import got from '../';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	let noStoreIndex = 0;
	s.on('/no-store', (req, res) => {
		noStoreIndex++;
		res.setHeader('Cache-Control', 'public, no-cache, no-store');
		res.end(noStoreIndex.toString());
	});

	let cacheIndex = 0;
	s.on('/cache', (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	s.on('/last-modified', (req, res) => {
		res.setHeader('Cache-Control', 'public, no-cache');
		res.setHeader('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT');
		let responseBody = 'last-modified';

		if (req.headers['if-modified-since'] === 'Wed, 21 Oct 2015 07:28:00 GMT') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	s.on('/etag', (req, res) => {
		res.setHeader('Cache-Control', 'public, no-cache');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'etag';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	await s.listen(s.port);
});

test('Non cacheable responses are not cached', async t => {
	const endpoint = '/no-store';
	const cache = new Map();

	const firstResponseInt = parseInt((await got(s.url + endpoint, {cache})).body, 10);
	const secondResponseInt = parseInt((await got(s.url + endpoint, {cache})).body, 10);

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

test('Stream responses are cached', async t => {
	const endpoint = '/cache';
	const cache = new Map();

	const firstResponseBody = await getStream(got.stream(s.url + endpoint, {cache}));
	const secondResponseBody = await getStream(got.stream(s.url + endpoint, {cache}));

	t.is(cache.size, 1);
	t.is(firstResponseBody, secondResponseBody);
});

test('Binary responses are cached', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const encoding = null;

	const firstResponse = await got(s.url + endpoint, {cache, encoding});
	const secondResponse = await got(s.url + endpoint, {cache, encoding});

	t.is(cache.size, 1);
	t.true(firstResponse.body instanceof Buffer);
	t.is(firstResponse.body.toString(), secondResponse.body.toString());
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

test('Stale cache entries with Last-Modified headers are revalidated', async t => {
	const endpoint = '/last-modified';
	const cache = new Map();

	const firstResponse = await got(s.url + endpoint, {cache});
	const secondResponse = await got(s.url + endpoint, {cache});

	t.is(cache.size, 1);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 304);
	t.is(firstResponse.body, 'last-modified');
	t.is(firstResponse.body, secondResponse.body);
});

test('Stale cache entries with ETag headers are revalidated', async t => {
	const endpoint = '/etag';
	const cache = new Map();

	const firstResponse = await got(s.url + endpoint, {cache});
	const secondResponse = await got(s.url + endpoint, {cache});

	t.is(cache.size, 1);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 304);
	t.is(firstResponse.body, 'etag');
	t.is(firstResponse.body, secondResponse.body);
});

test.after('cleanup', async () => {
	await s.close();
});
