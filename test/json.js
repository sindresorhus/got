import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.end('{"data":"dog"}');
});

s.on('/invalid', (req, res) => {
	res.end('/');
});

s.on('/204', (req, res) => {
	res.statusCode = 204;
	res.end();
});

s.on('/non200', (req, res) => {
	res.statusCode = 500;
	res.end('{"data":"dog"}');
});

s.on('/non200-invalid', (req, res) => {
	res.statusCode = 500;
	res.end('Internal error');
});

test.before('json - setup', async t => {
	await s.listen(s.port);
});

test('json - json option should parse response', async t => {
	t.same((await got(s.url, {json: true})).body, {data: 'dog'});
});

test('json - json option should not parse responses without a body', async t => {
	const {body} = await got(`${s.url}/204`, {json: true});
	t.is(body, '');
});

test('json - json option wrap parsing errors', async t => {
	try {
		await got(`${s.url}/invalid`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/Unexpected token/, err.message);
		t.ok(err.message.indexOf(err.hostname) !== -1, err.message);
		t.is(err.path, '/invalid');
	}
});

test('json - json option should parse non-200 responses', async t => {
	try {
		await got(`${s.url}/non200`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.same(err.response.body, {data: 'dog'});
	}
});

test('json - json option should catch errors on invalid non-200 responses', async t => {
	try {
		await got(`${s.url}/non200-invalid`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/Unexpected token/, err.message);
		t.is(err.response.body, 'Internal error');
		t.is(err.path, '/non200-invalid');
	}
});

test.after('json - cleanup', async t => {
	await s.close();
});
