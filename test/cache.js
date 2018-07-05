import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	let noStoreIndex = 0;
	s.on('/no-store', (req, res) => {
		res.setHeader('Cache-Control', 'public, no-cache, no-store');
		res.end(noStoreIndex.toString());
		noStoreIndex++;
	});

	let cacheIndex = 0;
	s.on('/cache', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
		cacheIndex++;
	});

	let status301Index = 0;
	s.on('/301', (req, res) => {
		if (status301Index === 0) {
			res.setHeader('Cache-Control', 'public, max-age=60');
			res.setHeader('Location', s.url + '/302');
			res.statusCode = 301;
		}
		res.end();
		status301Index++;
	});

	let status302Index = 0;
	s.on('/302', (req, res) => {
		if (status302Index === 0) {
			res.setHeader('Cache-Control', 'public, max-age=60');
			res.setHeader('Location', s.url + '/cache');
			res.statusCode = 302;
		}
		res.end();
		status302Index++;
	});

	await s.listen(s.port);
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

	const err = await t.throws(got(s.url + endpoint, {cache}));
	t.is(err.name, 'CacheError');
});

test.after('cleanup', async () => {
	await s.close();
});
