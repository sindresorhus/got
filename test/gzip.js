import zlib from 'zlib';
import test from 'ava';
import getStream from 'get-stream';
import pify from 'pify';
import got from '..';
import {createServer} from './helpers/server';

const testContent = 'Compressible response content.\n';
const testContentUncompressed = 'Uncompressed response content.\n';

let s;
let gzipData;

test.before('setup', async () => {
	s = await createServer();
	gzipData = await pify(zlib.gzip)(testContent);

	s.on('/', (req, res) => {
		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/plain');
		res.setHeader('Content-Encoding', 'gzip');

		if (req.method === 'HEAD') {
			res.end();
			return;
		}

		res.end(gzipData);
	});

	s.on('/corrupted', (req, res) => {
		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/plain');
		res.setHeader('Content-Encoding', 'gzip');
		res.end('Not gzipped content');
	});

	s.on('/missing-data', (req, res) => {
		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/plain');
		res.setHeader('Content-Encoding', 'gzip');
		res.end(gzipData.slice(0, -1));
	});

	s.on('/uncompressed', (req, res) => {
		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/plain');
		res.end(testContentUncompressed);
	});

	await s.listen(s.port);
});

test('decompress content', async t => {
	t.is((await got(s.url)).body, testContent);
});

test('decompress content - stream', async t => {
	t.is(await getStream(got.stream(s.url)), testContent);
});

test('handles gzip error', async t => {
	const err = await t.throws(got(`${s.url}/corrupted`));
	t.is(err.message, 'incorrect header check');
	t.is(err.path, '/corrupted');
	t.is(err.name, 'ReadError');
});

test('decompress option opts out of decompressing', async t => {
	const response = await got(s.url, {decompress: false});
	t.true(Buffer.compare(response.body, gzipData) === 0);
});

test('decompress option doesn\'t alter encoding of uncompressed responses', async t => {
	const response = await got(`${s.url}/uncompressed`, {decompress: false});
	t.is(response.body, testContentUncompressed);
});

test('preserve headers property', async t => {
	t.truthy((await got(s.url)).headers);
});

test('do not break HEAD responses', async t => {
	t.is((await got.head(s.url)).body, '');
});

test('ignore missing data', async t => {
	t.is((await got(`${s.url}/missing-data`)).body, testContent);
});

test('has url and requestUrl properties', async t => {
	const res = await got(s.url);
	t.truthy(res.url);
	t.truthy(res.requestUrl);
});

test.after('cleanup', async () => {
	await s.close();
});
