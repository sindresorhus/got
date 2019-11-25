import {promisify} from 'util';
import zlib = require('zlib');
import test from 'ava';
import getStream = require('get-stream');
import withServer from './helpers/with-server';

const testContent = 'Compressible response content.\n';
const testContentUncompressed = 'Uncompressed response content.\n';

let gzipData: Buffer;
test.before('setup', async () => {
	gzipData = await promisify<string, Buffer>(zlib.gzip)(testContent);
});

test('decompress content', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	t.is((await got('')).body, testContent);
});

test('decompress content - stream', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	t.is((await getStream(got.stream(''))), testContent);
});

test('handles gzip error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	await t.throwsAsync(got(''), {
		name: 'ReadError',
		message: 'incorrect header check'
	});
});

test('handles gzip error - stream', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	await t.throwsAsync(getStream(got.stream('')), {
		name: 'ReadError',
		message: 'incorrect header check'
	});
});

test('decompress option opts out of decompressing', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const {body} = await got({decompress: false});
	t.is(Buffer.compare(body, gzipData), 0);
});

test('decompress option doesn\'t alter encoding of uncompressed responses', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(testContentUncompressed);
	});

	const {body} = await got({decompress: false});
	t.is(body, testContentUncompressed);
});

test('preserves `headers` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	t.truthy((await got('')).headers);
});

test('does not break HEAD responses', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	t.is((await got.head('')).body, '');
});

test('ignore missing data', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData.slice(0, -1));
	});

	t.is((await got('')).body, testContent);
});

test('response has `url` and `requestUrl` properties', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const response = await got('');
	t.truthy(response.url);
	t.truthy(response.requestUrl);
});
