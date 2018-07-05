import {URL} from 'url';
import test from 'ava';
import pEvent from 'p-event';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.statusCode = 404;
		res.end();
	});

	s.on('/test', (req, res) => {
		res.end(req.url);
	});

	s.on('/?test=wow', (req, res) => {
		res.end(req.url);
	});

	s.on('/stream', (req, res) => {
		res.end('ok');
	});

	await s.listen(s.port);
});

test('url is required', async t => {
	const err = await t.throws(got());
	t.regex(err.message, /Parameter `url` must be a string or object, not undefined/);
});

test('url should be utf-8 encoded', async t => {
	const err = await t.throws(got(`${s.url}/%D2%E0%EB%EB%E8%ED`));
	t.regex(err.message, /Parameter `url` must contain valid UTF-8 character sequences/);
});

test('options are optional', async t => {
	t.is((await got(`${s.url}/test`)).body, '/test');
});

test('accepts url.parse object as first argument', async t => {
	t.is((await got({
		hostname: s.host,
		port: s.port,
		path: '/test'
	})).body, '/test');
});

test('requestUrl with url.parse object as first argument', async t => {
	t.is((await got({
		hostname: s.host,
		port: s.port,
		path: '/test'
	})).requestUrl, `${s.url}/test`);
});

test('overrides querystring from opts', async t => {
	t.is((await got(`${s.url}/?test=doge`, {query: {test: 'wow'}})).body, '/?test=wow');
});

test('should throw with auth in url string', async t => {
	const err = await t.throws(got('https://test:45d3ps453@account.myservice.com/api/token'));
	t.regex(err.message, /Basic authentication must be done with the `auth` option/);
});

test('does not throw with auth in url object', async t => {
	await t.notThrows(got({
		auth: 'foo:bar',
		hostname: s.host,
		port: s.port,
		path: '/test'
	}));
});

test('should throw when body is set to object', async t => {
	await t.throws(got(`${s.url}/`, {body: {}}), TypeError);
});

test('WHATWG URL support', async t => {
	const wURL = new URL(`${s.url}/test`);
	await t.notThrows(got(wURL));
});

test('should return streams when using stream option', async t => {
	const data = await pEvent(got(`${s.url}/stream`, {stream: true}), 'data');
	t.is(data.toString(), 'ok');
});

test('should not allow stream and JSON option at the same time', async t => {
	const error = await t.throws(got(`${s.url}/stream`, {stream: true, json: true}));
	t.is(error.message, 'Got can not be used as a stream when the `json` option is used');
});

test.after('cleanup', async () => {
	await s.close();
});
