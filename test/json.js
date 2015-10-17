import test from 'ava';
import got from '../';
import {createServer} from './_server';

let s;

test.before('setup', async t => {
	s = await createServer();

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

	await s.listen(s.port);
});

test('parses response', async t => {
	t.same((await got(s.url, {json: true})).body, {data: 'dog'});
});

test('not parses responses without a body', async t => {
	const {body} = await got(`${s.url}/204`, {json: true});
	t.is(body, '');
});

test('wraps parsing errors', async t => {
	try {
		await got(`${s.url}/invalid`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/Unexpected token/, err.message);
		t.ok(err.message.indexOf(err.hostname) !== -1, err.message);
		t.is(err.path, '/invalid');
	}
});

test('parses non-200 responses', async t => {
	try {
		await got(`${s.url}/non200`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.same(err.response.body, {data: 'dog'});
	}
});

test('catches errors on invalid non-200 responses', async t => {
	try {
		await got(`${s.url}/non200-invalid`, {json: true});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/Unexpected token/, err.message);
		t.is(err.response.body, 'Internal error');
		t.is(err.path, '/non200-invalid');
	}
});

test.after('cleanup', async t => {
	await s.close();
});
