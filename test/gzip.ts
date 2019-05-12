import {IncomingMessage, ServerResponse} from 'http';
import {promisify} from 'util';
import zlib from 'zlib';
import test, {ExecutionContext} from 'ava';
import getStream from 'get-stream';
import {ReadError} from '../source/errors';
import withServer, {SecureGot} from './helpers/with-server';

const zlibAsync = promisify(zlib.gzip);

const testContent = 'Compressible response content.\n';
const testContentUncompressed = 'Uncompressed response content.\n';
let gzipData: Buffer;

test.before('setup', async () => {
	gzipData = await zlibAsync(testContent) as Buffer;
});

test('decompress content', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	t.is((await got('')).body, testContent);
});

test('decompress content - stream', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	t.is((await getStream(got.stream(''))), testContent);
});

test('handles gzip error', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	const error: ReadError = await t.throwsAsync(got(''), 'incorrect header check');

	t.is(error.options.path, '/');
	t.is(error.name, 'ReadError');
});

test('handles gzip error - stream', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	const error: ReadError = await t.throwsAsync(getStream(got.stream('')), 'incorrect header check');

	t.is(error.options.path, '/');
	t.is(error.name, 'ReadError');
});

test('decompress option opts out of decompressing', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const {body} = await got({decompress: false});
	t.is(Buffer.compare(body, gzipData), 0);
});

test('decompress option doesn\'t alter encoding of uncompressed responses', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.end(testContentUncompressed);
	});

	const {body} = await got({decompress: false});
	t.is(body, testContentUncompressed);
});

test('preserves `headers` property', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	t.truthy((await got('')).headers);
});

test('does not break HEAD responses', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.end();
	});

	t.is((await got.head('')).body, '');
});

test('ignore missing data', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData.slice(0, -1));
	});

	t.is((await got('')).body, testContent);
});

test('response has `url` and `requestUrl` properties', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const response = await got('');
	t.truthy(response.url);
	t.truthy(response.requestUrl);
});
