import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.end('ok');
});

s.on('/empty', (req, res) => {
	res.end();
});

s.on('/404', (req, res) => {
	setTimeout(() => {
		res.statusCode = 404;
		res.end('not');
	}, 10);
});

s.on('/?recent=true', (req, res) => {
	res.end('recent');
});

test.before('http - setup', t => {
	s.listen(s.port, () => t.end());
});

test('http - callback mode', t => {
	got(s.url, (err, data) => {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('http - protocol-less URLs', t => {
	got(s.url.replace(/^http:\/\//, ''), (err, data) => {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('http - empty response', t => {
	got(`${s.url}/empty`, (err, data) => {
		t.ifError(err);
		t.is(data, '');
		t.end();
	});
});

test('http - error with code', t => {
	got(`${s.url}/404`, (err, data) => {
		t.ok(err);
		t.is(err.statusCode, 404);
		t.is(data, 'not');
		t.end();
	});
});

test('http - buffer on encoding === null', t => {
	got(s.url, {encoding: null}, (err, data) => {
		t.ifError(err);
		t.ok(Buffer.isBuffer(data));
		t.end();
	});
});

test('http - timeout option', t => {
	got(`${s.url}/404`, {timeout: 1, retries: 0}, err => {
		t.is(err.code, 'ETIMEDOUT');
		t.end();
	});
});

test('http - query option', t => {
	t.plan(4);

	got(s.url, {query: {recent: true}}, (err, data) => {
		t.ifError(err);
		t.is(data, 'recent');
	});

	got(s.url, {query: 'recent=true'}, (err, data) => {
		t.ifError(err);
		t.is(data, 'recent');
	});
});

test.after('http - cleanup', t => {
	s.close();
	t.end();
});
