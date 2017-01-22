import test from 'ava';
import got from '../';
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

	await s.listen(s.port);
});

test.failing('parses JSON response', async t => {
	t.deepEqual((await got(s.url, {parse: JSON.parse})).body, {data: 'dog'});
});

test('not parses responses without a body', async t => {
	const {body} = await got(`${s.url}/no-body`, {parse: JSON.parse});
	t.is(body, '');
});

test.failing('wraps parsing errors', async t => {
	try {
		await got(`${s.url}/invalid`, {parse: JSON.parse});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regex(err.message, /Unexpected token/);
		t.true(err.message.indexOf(err.hostname) !== -1, err.message);
		t.is(err.path, '/invalid');
	}
});

test.failing('parses non-200 responses', async t => {
	try {
		await got(`${s.url}/non200`, {parse: JSON.parse});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.deepEqual(err.response.body, {data: 'dog'});
	}
});

test.failing('catches errors on invalid non-200 responses', async t => {
	try {
		await got(`${s.url}/non200-invalid`, {parse: JSON.parse});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regex(err.message, /Unexpected token/);
		t.is(err.response.body, 'Internal error');
		t.is(err.path, '/non200-invalid');
	}
});

test('should have statusCode in err', async t => {
	try {
		await got(`${s.url}/non200-invalid`, {parse: JSON.parse});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.statusCode, 500);
	}
});

test.after('cleanup', async () => {
	await s.close();
});
