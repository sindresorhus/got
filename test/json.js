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

test.before('json - setup', t => {
	s.listen(s.port, () => t.end());
});

test('json - json option should parse response', t => {
	got(s.url, {json: true}, (err, json) => {
		t.ifError(err);
		t.same(json, {data: 'dog'});
		t.end();
	});
});

test('json - json option should not parse responses without a body', t => {
	got(`${s.url}/204`, {json: true}, err => {
		t.ifError(err);
		t.end();
	});
});

test('json - json option wrap parsing errors', t => {
	got(`${s.url}/invalid`, {json: true}, err => {
		t.ok(err);
		t.regexTest(/Unexpected token/, err.message);
		t.ok(err.message.indexOf(err.hostname) !== -1, err.message);
		t.is(err.path, '/invalid');
		t.end();
	});
});

test('json - json option should parse non-200 responses', t => {
	got(`${s.url}/non200`, {json: true}, (err, json) => {
		t.ok(err);
		t.same(json, {data: 'dog'});
		t.end();
	});
});

test('json - json option should catch errors on invalid non-200 responses', t => {
	got(`${s.url}/non200-invalid`, {json: true}, (err, json) => {
		t.ok(err);
		t.regexTest(/Unexpected token/, err.message);
		t.is(json, 'Internal error');
		t.is(err.path, '/non200-invalid');
		t.end();
	});
});

test.after('json - cleanup', t => {
	s.close();
	t.end();
});
