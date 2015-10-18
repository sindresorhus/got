import test from 'ava';
import pify from 'pify';
import got from '../';
import {createServer} from './_server';

let s;

test.before('setup', async t => {
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
	try {
		await got();
		t.fail('Exception is not thrown');
	} catch (err) {
		t.regexTest(/Parameter `url` must be a string or object, not undefined/, err.message);
	}
});

test('options are optional', async t => {
	t.is((await got(`${s.url}/test`)).body, '/test');
});

test('options are optional', t => {
	got(`${s.url}/test`, function (err, data) {
		t.is(data, '/test');
		t.end();
	});
});

test('accepts url.parse object as first argument', async t => {
	t.is((await got({hostname: s.host, port: s.port, path: '/test'})).body, '/test');
});

test('overrides querystring from opts', async t => {
	t.is((await got(`${s.url}/?test=doge`, {query: {test: 'wow'}})).body, '/?test=wow');
});

test('should throw with auth in url', async t => {
	try {
		await got(`https://test:45d3ps453@account.myservice.com/api/token`);
		t.fail('Exception is not thrown');
	} catch (err) {
		t.regexTest(/Basic authentication must be done with auth option/, err.message);
	}
});

test('accepts url.parse object as first argument', async t => {
	t.is((await got({hostname: s.host, port: s.port, path: '/test'})).body, '/test');
});

test.after('cleanup', async t => {
	await s.close();
});
