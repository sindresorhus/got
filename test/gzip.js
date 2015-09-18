import zlib from 'zlib';
import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();
const testContent = 'Compressible response content.\n';

s.on('/', (req, res) => {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Encoding', 'gzip');
	zlib.gzip(testContent, (_, data) => res.end(data));
});

s.on('/corrupted', (req, res) => {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Encoding', 'gzip');
	res.end('Not gzipped content');
});

test.before('gzip - setup', t => {
	s.listen(s.port, () => t.end());
});

test('gzip - ungzip content', t => {
	got(s.url, (err, data) => {
		t.ifError(err);
		t.is(data, testContent);
		t.end();
	});
});

test('gzip - ungzip error', t => {
	got(`${s.url}/corrupted`, err => {
		t.ok(err);
		t.is(err.message, 'incorrect header check');
		t.is(err.path, '/corrupted');
		t.is(err.name, 'ReadError');
		t.end();
	});
});

test('gzip - preserve headers property', t => {
	got(s.url, (err, data, res) => {
		t.ifError(err);
		t.ok(res.headers);
		t.end();
	});
});

test.after('gzip - cleanup', t => {
	s.close();
	t.end();
});
