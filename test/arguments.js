import {URL} from 'universal-url';
import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/test', (req, res) => {
		res.send(req.url);
	});
});

test('url is required', async t => {
	const err = await t.throws(got());
	t.regex(err.message, /Parameter `url` must be a string or object, not undefined/);
});

test('options are optional', async t => {
	t.is((await got(`${s.url}/test`)).body, '/test');
});

test('accepts url.parse object as first argument', async t => {
	t.is((await got({
		hostname: 'localhost',
		port: s.port,
		path: '/test'
	})).body, '/test');
});

test('requestUrl with url.parse object as first argument', async t => {
	t.is((await got({
		hostname: 'localhost',
		port: s.port,
		path: '/test'
	})).requestUrl, `${s.url}/test`);
});

test('overrides querystring from opts', async t => {
	t.is((await got(`${s.url}/test?q=doge`, {query: {q: 'wow'}})).body, '/test?q=wow');
});

test('should throw with auth in url', async t => {
	const err = await t.throws(got('https://test:45d3ps453@account.myservice.com/api/token'));
	t.regex(err.message, /Basic authentication must be done with auth option/);
});

test('should throw when body is set to object', async t => {
	await t.throws(got(`${s.url}/`, {body: {}}), TypeError);
});

test('WHATWG URL support', async t => {
	const wURL = new URL(`${s.url}/test`);
	await t.notThrows(got(wURL));
});

test('throws on WHATWG URL with auth', async t => {
	const wURL = new URL(`${s.url}/test`);
	wURL.username = 'alex';
	wURL.password = 'secret';
	await t.throws(got(wURL));
});

test.after('cleanup', async () => {
	await s.close();
});
