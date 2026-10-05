import {Buffer} from 'node:buffer';
import zlib, {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import got, {ReadError} from '../source/index.js';
import test from './helpers/test.js';
import {errorMatching} from './helpers/error-matching.js';
import {rejects} from './helpers/rejects.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';

const testContent = 'Compressible response content.\n';
const testContentUncompressed = 'Uncompressed response content.\n';

let gzipData: Uint8Array;
test.before(async () => {
	gzipData = await new Promise<Uint8Array>((resolve, reject) => {
		zlib.gzip(testContent, (error, result) => {
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
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	assert.strictEqual((await got('')).body, testContent);
});

test('decompress content on error', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.status(404);
		response.end(gzipData);
	});

	const error = await rejects(got(''));

	assert.strictEqual(error?.response.body, testContent);
});

test('decompress content - stream', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	assert.strictEqual((await getStream(got.stream(''))), testContent);
});

test('handles gzip error', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	await assert.rejects(got(''), {
		name: 'ReadError',
		message: 'incorrect header check',
		code: 'ERR_READING_RESPONSE_STREAM',
	});
});

test('no unhandled `Premature close` error', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.write('Not gzipped content');
	});

	await assert.rejects(got(''), {
		name: 'ReadError',
		// `The server aborted pending request` on Node.js 15 or later.
		message: /incorrect header check|The server aborted pending request/v,
	});
});

test('handles gzip error - stream', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end('Not gzipped content');
	});

	await assert.rejects(getStream(got.stream('')), {
		name: 'ReadError',
		message: 'incorrect header check',
	});
});

test('decompress option opts out of decompressing', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const {body} = await got({decompress: false, responseType: 'buffer'});
	assert.strictEqual(Buffer.compare(body, gzipData), 0);
	assert.strictEqual(Buffer.isBuffer(body), false);
});

test('decompress option doesn\'t alter encoding of uncompressed responses', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(testContentUncompressed);
	});

	const {body} = await got({decompress: false});
	assert.strictEqual(body, testContentUncompressed);
});

test('preserves `headers` property', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	assert.ok((await got('')).headers);
});

test('does not break HEAD responses', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	assert.strictEqual((await got.head('')).body, '');
});

test('does not ignore missing data', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData.subarray(0, -1));
	});

	await assert.rejects(got(''), errorMatching(ReadError, {message: 'unexpected end of file'}));
});

test('does not ignore aborted compressed responses', async _t => {
	const {close, port} = await createRawHttpServer(socket => {
		socket.once('data', () => {
			socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip\r\nContent-Length: ${gzipData.length}\r\nConnection: close\r\n\r\n`);
			socket.write(gzipData.subarray(0, -1));
			socket.destroy();
		});
	});

	try {
		await assert.rejects(got(`http://localhost:${port}`, {retry: {limit: 0}}), ReadError);
	} finally {
		await close();
	}
});

test('does not throw on compressed close-delimited response without content-length', async _t => {
	const {close, port} = await createRawHttpServer(socket => {
		socket.once('data', () => {
			socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n${Buffer.from(gzipData).toString('binary')}`, 'binary');
		});
	});

	try {
		assert.strictEqual((await got(`http://localhost:${port}`, {retry: {limit: 0}})).body, testContent);
	} finally {
		await close();
	}
});

test('response has `url` and `requestUrl` properties', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	const response = await got('');
	assert.ok(response.url);
	assert.ok(response.requestUrl);
});

test('compressed and uncompressed responses have consistent spreadability', withServer, async (_t, server, got) => {
	server.get('/compressed', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.end(gzipData);
	});

	server.get('/uncompressed', (_request, response) => {
		response.end(testContentUncompressed);
	});

	// Test compressed response spreadability
	const compressedResponse = await got('compressed');
	assert.strictEqual(Object.hasOwn(compressedResponse, 'headers'), true);
	assert.strictEqual(Object.getOwnPropertyDescriptor(compressedResponse, 'headers')?.enumerable ?? false, true);
	const compressedSpread = {...compressedResponse};

	assert.strictEqual(Object.hasOwn(compressedSpread, 'headers'), true);
	assert.ok(compressedSpread.headers);
	assert.strictEqual(compressedSpread.statusCode, 200);
	assert.ok(compressedSpread.body);

	// Test uncompressed response spreadability
	const uncompressedResponse = await got('uncompressed');
	assert.strictEqual(Object.hasOwn(uncompressedResponse, 'headers'), true);
	assert.strictEqual(Object.getOwnPropertyDescriptor(uncompressedResponse, 'headers')?.enumerable ?? false, true);
	const uncompressedSpread = {...uncompressedResponse};

	assert.strictEqual(Object.hasOwn(uncompressedSpread, 'headers'), true);
	assert.ok(uncompressedSpread.headers);
	assert.strictEqual(uncompressedSpread.statusCode, 200);
	assert.ok(uncompressedSpread.body);

	// Both should have the same spreadable properties
	assert.ok(compressedSpread.headers);
	assert.ok(uncompressedSpread.headers);
	assert.ok(compressedSpread.statusCode);
	assert.ok(uncompressedSpread.statusCode);
});

for (const encoding of ['x-gzip', 'X-GZip', 'gzip, x-gzip', 'x-gzip, gzip']) {
	test(`decodes the standard ${encoding} content coding alias`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('content-encoding', encoding);
			const payload = gzipSync('decoded payload');
			response.end(encoding.includes(',') ? gzipSync(payload) : payload);
		});

		assert.strictEqual(await got('').text(), 'decoded payload');
	});
}

test('the compressed alias retains its compressed bytes when decompression is disabled', withServer, async (_t, server, got) => {
	const payload = gzipSync('encoded payload');
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'x-gzip');
		response.end(payload);
	});

	const response = await got('', {decompress: false});

	assert.deepStrictEqual(response.rawBody, new Uint8Array(payload));
	assert.deepStrictEqual(response.body, new Uint8Array(payload));
	assert.strictEqual(response.headers['content-encoding'], 'x-gzip');
});

test('content-encoding is matched case-insensitively', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'GZIP');
		response.end(gzipSync(Buffer.from('ok')));
	});

	const {body} = await got('', {responseType: 'text'});
	assert.strictEqual(body, 'ok');
});
