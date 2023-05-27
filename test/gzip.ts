import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import zlib from 'node:zlib';
import test from 'ava';
import getStream from 'get-stream';
import {ReadError, type HTTPError} from '../source/index.js';
import withServer from './helpers/with-server.js';

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

test('decompress content on error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.status(404);
		response.end(gzipData);
	});

	const error = await t.throwsAsync<HTTPError>(got(''));

	t.is(error?.response.body, testContent);
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
		message: 'incorrect header check',
	});
});

test('no unhandled `Premature close` error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.write('Not gzipped content');
	});

	await t.throwsAsync(got(''), {
		name: 'ReadError',
		// `The server aborted pending request` on Node.js 15 or later.
		message: /incorrect header check|The server aborted pending request/,
	});
});

test('handles gzip error - stream', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	await t.throwsAsync(getStream(got.stream('')), {
		name: 'ReadError',
		message: 'incorrect header check',
	});
});

test('decompress option opts out of decompressing', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const {body} = await got({decompress: false, responseType: 'buffer'});
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

test('does not ignore missing data', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData.slice(0, -1));
	});

	await t.throwsAsync(got(''), {
		instanceOf: ReadError,
		message: 'unexpected end of file',
	});
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
