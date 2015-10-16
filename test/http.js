import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

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

test.before('http - setup', async t => {
	await s.listen(s.port);
});

test('http - simple request', async t => {
	t.is((await got(s.url)).body, 'ok');
});

test('http - protocol-less URLs', async t => {
	t.is((await got(s.url.replace(/^http:\/\//, ''))).body, 'ok');
});

test('http - empty response', async t => {
	t.is((await got(`${s.url}/empty`)).body, '');
});

test('http - error with code', async t => {
	try {
		await got(`${s.url}/404`);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.statusCode, 404);
		t.is(err.response.body, 'not');
	}
});

test('http - buffer on encoding === null', async t => {
	const data = (await got(s.url, {encoding: null})).body;
	t.ok(Buffer.isBuffer(data));
});

test('http - timeout option', async t => {
	try {
		await got(`${s.url}/404`, {timeout: 1, retries: 0});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('http - query option', async t => {
	t.is((await got(s.url, {query: {recent: true}})).body, 'recent');
	t.is((await got(s.url, {query: 'recent=true'})).body, 'recent');
});

test.after('http - cleanup', async t => {
	await s.close();
});
