import test from 'ava';
import got from '..';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('{"data":"dog"}');
	});

	s.on('/invalid', (req, res) => {
		res.end('/');
	});

	s.on('/no-body', (req, res) => {
		res.statusCode = 200;
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

	s.on('/headers', (req, res) => {
		res.end(JSON.stringify(req.headers));
	});

	await s.listen(s.port);
});

test('parses response', async t => {
	t.deepEqual((await got(s.url, {json: true})).body, {data: 'dog'});
});

test('not parses responses without a body', async t => {
	const {body} = await got(`${s.url}/no-body`, {json: true});
	t.is(body, '');
});

test('wraps parsing errors', async t => {
	try {
		await got(`${s.url}/invalid`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regex(err.message, /Unexpected token/);
		t.true(err.message.indexOf(err.hostname) !== -1, err.message);
		t.is(err.path, '/invalid');
	}
});

test('parses non-200 responses', async t => {
	try {
		await got(`${s.url}/non200`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.deepEqual(err.response.body, {data: 'dog'});
	}
});

test('ignores errors on invalid non-200 responses', async t => {
	try {
		await got(`${s.url}/non200-invalid`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.message, 'Response code 500 (Internal Server Error)');
		t.is(err.response.body, 'Internal error');
		t.is(err.path, '/non200-invalid');
	}
});

test('should have statusCode in err', async t => {
	const err = await t.throws(got(`${s.url}/invalid`, {json: true}));
	t.is(err.constructor, got.ParseError);
	t.is(err.statusCode, 200);
});

test('should set correct headers', async t => {
	const {body: headers} = await got(`${s.url}/headers`, {json: true, body: {}});
	t.is(headers['content-type'], 'application/json');
	t.is(headers.accept, 'application/json');
});

test.after('cleanup', async () => {
	await s.close();
});
