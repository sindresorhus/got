import test from 'ava';
import got from '../';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();
	await s.listen(s.port);
});

test('Non cacheable requests are not cached', async t => {
	const endpoint = '/no-cache';
	let noCacheIndex = 0;
	s.on(endpoint, (req, res) => {
		noCacheIndex++;
		res.end(noCacheIndex.toString());
	});

	const cache = new Map();

	const firstResponse = parseInt((await got(s.url + endpoint, {cache})).body, 10);
	const secondResponse = parseInt((await got(s.url + endpoint, {cache})).body, 10);

	t.is(secondResponse, (firstResponse + 1));
});

test('Cacheable requests are cached', async t => {
	const endpoint = '/cache';
	let cacheIndex = 0;
	s.on(endpoint, (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	const cache = new Map();

	const firstResponse = await got(s.url + endpoint, {cache});
	const secondResponse = await got(s.url + endpoint, {cache});

	t.is(firstResponse.body, secondResponse.body);
});

test('Binary responses are cached', async t => {
	const endpoint = '/cache-bin';
	let cacheIndex = 0;
	s.on(endpoint, (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	const cache = new Map();
	const encoding = null;

	const firstResponse = await got(s.url + endpoint, {cache, encoding});
	const secondResponse = await got(s.url + endpoint, {cache, encoding});

	t.is(firstResponse.body.toString(), secondResponse.body.toString());
});

test('Cached response is re-encoded to current encoding option', async t => {
	const endpoint = '/cache-encoding';
	let cacheIndex = 0;
	s.on(endpoint, (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	const cache = new Map();
	const firstEncoding = 'base64';
	const secondEncoding = 'hex';

	const firstResponse = await got(s.url + endpoint, {cache, encoding: firstEncoding});
	const secondResponse = await got(s.url + endpoint, {cache, encoding: secondEncoding});

	const expectedSecondResponseBody = Buffer.from(firstResponse.body, firstEncoding).toString(secondEncoding);

	t.is(secondResponse.body, expectedSecondResponseBody);
});

test.after('cleanup', async () => {
	await s.close();
});
