import test from 'ava';
import got from '../';
import {createServer} from './_server';

let s;

test.before('setup', async t => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/empty', (req, res) => {
		res.end();
	});

	s.on('/404', (req, res) => {
		setTimeout(() => {
			res.statusCode = 404;
			res.end('not');
		}, 10);
	});

	s.on('/?recent=true', (req, res) => {
		res.end('recent');
	});

	await s.listen(s.port);
});

test('simple request', async t => {
	t.is((await got(s.url)).body, 'ok');
});

test('protocol-less URLs', async t => {
	t.is((await got(s.url.replace(/^http:\/\//, ''))).body, 'ok');
});

test('empty response', async t => {
	t.is((await got(`${s.url}/empty`)).body, '');
});

test('error with code', async t => {
	try {
		await got(`${s.url}/404`);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.statusCode, 404);
		t.is(err.response.body, 'not');
	}
});

test('buffer on encoding === null', async t => {
	const data = (await got(s.url, {encoding: null})).body;
	t.ok(Buffer.isBuffer(data));
});

test('timeout option', async t => {
	try {
		await got(`${s.url}/404`, {timeout: 1, retries: 0});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('query option', async t => {
	t.is((await got(s.url, {query: {recent: true}})).body, 'recent');
	t.is((await got(s.url, {query: 'recent=true'})).body, 'recent');
});

test.after('cleanup', async t => {
	await s.close();
});
