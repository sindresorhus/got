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

test('gzip - ungzip content', async t => {
	t.is((await got(s.url)).body, testContent);
});

test('gzip - ungzip error', async t => {
	try {
		await got(`${s.url}/corrupted`);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.message, 'incorrect header check');
		t.is(err.path, '/corrupted');
		t.is(err.name, 'ReadError');
	}
});

test('gzip - preserve headers property', async t => {
	t.ok((await got(s.url)).headers);
});

test.after('gzip - cleanup', t => {
	s.close();
	t.end();
});
