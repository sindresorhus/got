import {Buffer} from 'node:buffer';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import test from './helpers/test.js';
import {rejects} from './helpers/rejects.js';
import withServer from './helpers/with-server.js';

const supportsZstd = typeof zlib.zstdCompress === 'function';
if (supportsZstd) {
	const testContent = 'Compressible response content.\n';

	let zstdData: Uint8Array;
	test.before(async () => {
		zstdData = await new Promise<Uint8Array>((resolve, reject) => {
			zlib.zstdCompress(testContent, (error, result) => {
				if (error) {
					reject(error);
					return;
				}

				resolve(result);
			});
		});
	});

	test('decompress content', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		assert.strictEqual((await got('')).body, testContent);
	});

	test('decompress content on error', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.status(404);
			response.end(zstdData);
		});

		const error = await rejects(got(''));

		assert.strictEqual(error?.response.body, testContent);
	});

	test('decompress content - stream', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		assert.strictEqual((await getStream(got.stream(''))), testContent);
	});

	test('handles zstd error', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end('Not zstd content');
		});
		await assert.rejects(got(''), {
			name: 'ReadError',
		});
	});

	test('handles zstd error - stream', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end('Not zstd content');
		});
		await assert.rejects(getStream(got.stream('')), {
			name: 'ReadError',
		});
	});

	test('decompress option opts out of decompressing', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		const {body} = await got({decompress: false, responseType: 'buffer'});
		assert.strictEqual(Buffer.compare(body, zstdData), 0);
		assert.strictEqual(Buffer.isBuffer(body), false);
	});

	test('preserves `headers` property', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		assert.ok((await got('')).headers);
	});

	test('response has `url` and `requestUrl` properties', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('Content-Encoding', 'zstd');
			response.end(zstdData);
		});

		const response = await got('');
		assert.ok(response.url);
		assert.ok(response.requestUrl);
	});
} else {
	test.skip('zstd support not available - Node.js >= 22.15.0 required', () => {});
}
