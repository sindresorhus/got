import is from '@sindresorhus/is';
import test from 'ava';
import got from '..';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/empty', (req, res) => {
		res.end();
	});

	s.on('/304', (req, res) => {
		res.statusCode = 304;
		res.end();
	});

	s.on('/404', (req, res) => {
		res.statusCode = 404;
		res.end('not');
	});

	s.on('/?recent=true', (req, res) => {
		res.end('recent');
	});

	await s.listen(s.port);
});

test('simple request', async t => {
	t.is((await got(s.url)).body, 'ok');
});

test('empty response', async t => {
	t.is((await got(`${s.url}/empty`)).body, '');
});

test('requestUrl response', async t => {
	t.is((await got(s.url)).requestUrl, `${s.url}/`);
	t.is((await got(`${s.url}/empty`)).requestUrl, `${s.url}/empty`);
});

test('error with code', async t => {
	const err = await t.throws(got(`${s.url}/404`));
	t.is(err.statusCode, 404);
	t.is(err.response.body, 'not');
});

test('status code 304 doesn\'t throw', async t => {
	const p = got(`${s.url}/304`);
	await t.notThrows(p);
	const response = await p;
	t.is(response.statusCode, 304);
	t.is(response.body, '');
});

test('doesn\'t throw on throwHttpErrors === false', async t => {
	t.is((await got(`${s.url}/404`, {throwHttpErrors: false})).body, 'not');
});

test('invalid protocol throws', async t => {
	const err = await t.throws(got('c:/nope.com', {json: true}));
	t.is(err.constructor, got.UnsupportedProtocolError);
});

test('buffer on encoding === null', async t => {
	const data = (await got(s.url, {encoding: null})).body;
	t.true(is.buffer(data));
});

test('query option', async t => {
	t.is((await got(s.url, {query: {recent: true}})).body, 'recent');
	t.is((await got(s.url, {query: 'recent=true'})).body, 'recent');
});

test('requestUrl response when sending url as param', async t => {
	t.is((await got(s.url, {hostname: s.host, port: s.port})).requestUrl, `${s.url}/`);
	t.is((await got({hostname: s.host, port: s.port})).requestUrl, `${s.url}/`);
});

test('response contains url', async t => {
	t.is((await got(s.url)).url, `${s.url}/`);
});

test.after('cleanup', async () => {
	await s.close();
});
