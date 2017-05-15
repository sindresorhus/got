import test from 'ava';
import got from '..';
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

	await s.listen(s.port);
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

test('should throw with auth in url', async t => {
	try {
		await got('https://test:45d3ps453@account.myservice.com/api/token');
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regex(err.message, /Basic authentication must be done with auth option/);
	}
});

test('should throw when body is set to object', async t => {
	await t.throws(got(`${s.url}/`, {body: {}}), TypeError);
});

test.after('cleanup', async () => {
	await s.close();
});
