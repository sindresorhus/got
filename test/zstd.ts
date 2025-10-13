import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import zlib from 'node:zlib';
import test from 'ava';
import getStream from 'get-stream';
import {type HTTPError} from '../source/index.js';
import withServer from './helpers/with-server.js';

const supportsZstd = typeof zlib.zstdCompress === 'function';

if (supportsZstd) {
	const testContent = 'Compressible response content.\n';

	let zstdData: Buffer;
	test.before('setup', async () => {
		zstdData = await promisify<string, Buffer>(zlib.zstdCompress)(testContent);
	});

	test('decompress content', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		t.is((await got('')).body, testContent);
	});

	test('decompress content on error', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.status(404);
			response.end(zstdData);
		});

		const error = await t.throwsAsync<HTTPError>(got(''));

		t.is(error?.response.body, testContent);
	});

	test('decompress content - stream', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		t.is((await getStream(got.stream(''))), testContent);
	});

	test('handles zstd error', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end('Not zstd content');
		});

		await t.throwsAsync(got(''), {
			name: 'ReadError',
		});
	});

	test('handles zstd error - stream', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end('Not zstd content');
		});

		await t.throwsAsync(getStream(got.stream('')), {
			name: 'ReadError',
		});
	});

	test('decompress option opts out of decompressing', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		const {body} = await got({decompress: false, responseType: 'buffer'});
		t.is(Buffer.compare(body, zstdData), 0);
	});

	test('preserves `headers` property', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		t.truthy((await got('')).headers);
	});

	test('response has `url` and `requestUrl` properties', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		const response = await got('');
		t.truthy(response.url);
		t.truthy(response.requestUrl);
	});
} else {
	test('zstd support not available - Node.js >= 22.15.0 required', t => {
		t.pass('Skipping zstd tests - not supported in this Node.js version');
	});
}
