import util from 'util';
import zlib from 'zlib';
import test from 'ava';
import getStream from 'get-stream';
import got from '../source';
import {createServer} from './helpers/server';

const testContent = 'Compressible response content.\n';
const testContentUncompressed = 'Uncompressed response content.\n';

let s;
let gzipData;

test.before('setup', async () => {
	s = await createServer();
	gzipData = await util.promisify(zlib.gzip)(testContent);

	s.on('/', (request, response) => {
		response.statusCode = 200;
		response.setHeader('Content-Type', 'text/plain');
		response.setHeader('Content-Encoding', 'gzip');

		if (request.method === 'HEAD') {
			response.end();
			return;
		}

		response.end(gzipData);
	});

	s.on('/corrupted', (request, response) => {
		response.statusCode = 200;
		response.setHeader('Content-Type', 'text/plain');
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	s.on('/missing-data', (request, response) => {
		response.statusCode = 200;
		response.setHeader('Content-Type', 'text/plain');
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData.slice(0, -1));
	});

	s.on('/uncompressed', (request, response) => {
		response.statusCode = 200;
		response.setHeader('Content-Type', 'text/plain');
		response.end(testContentUncompressed);
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('decompress content', async t => {
	t.is((await got(s.url)).body, testContent);
});

test('decompress content - stream', async t => {
	t.is(await getStream(got.stream(s.url)), testContent);
});

test('handles gzip error', async t => {
	const error = await t.throwsAsync(got(`${s.url}/corrupted`));
	t.is(error.message, 'incorrect header check');
	t.is(error.path, '/corrupted');
	t.is(error.name, 'ReadError');
});

test('handles gzip error - stream', async t => {
	const error = await t.throwsAsync(getStream(got.stream(`${s.url}/corrupted`)));
	t.is(error.message, 'incorrect header check');
	t.is(error.path, '/corrupted');
	t.is(error.name, 'ReadError');
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
	const response = await got(s.url);
	t.truthy(response.url);
	t.truthy(response.requestUrl);
});
