import {Buffer} from 'node:buffer';
import http from 'node:http';
import zlib, {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import Responselike from 'responselike';
import got, {ReadError, RequestError} from '../source/index.js';
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

const maxContentEncodings = 5;
const tooManyContentEncodings = maxContentEncodings + 1;
const gzipEncodingList = (count: number) => Array.from({length: count}, () => 'gzip').join(', ');
const gzipEncoded = (count: number): Uint8Array => {
	let payload: Uint8Array = Buffer.from(testContent);
	for (let index = 0; index < count; index++) {
		payload = gzipSync(payload);
	}

	return payload;
};

const tooManyContentCodingsMessage = `Too many content codings in the response: ${tooManyContentEncodings}. The maximum is ${maxContentEncodings}.`;

test('rejects a response with too many content codings', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.setHeader('content-encoding', contentEncoding);
		response.end(gzipEncoded(tooManyContentEncodings));
	});

	const error = await rejects(got('', {retry: {limit: 0}}), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(error.response?.statusCode, 500);
	assert.strictEqual(error.response?.headers['content-encoding'], contentEncoding);
	assert.strictEqual(error.response?.body, undefined);
	assert.strictEqual(error.response?.rawBody, undefined);
	assert.strictEqual(error.request?.isFromCache, false);
});

test('rejects a response with too many content codings - stream', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', contentEncoding);
		response.end('body');
	});

	const error = await rejects(getStream(got.stream('')), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(error.response?.statusCode, 200);
	assert.strictEqual(error.response?.headers['content-encoding'], contentEncoding);
	assert.strictEqual(error.response?.body, undefined);
	assert.strictEqual(error.response?.rawBody, undefined);
});

test('releases a custom request response when the content codings are rejected', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', contentEncoding);
		response.write('partial');
		// Never end, so an unreleased response keeps its socket open.
	});

	let nativeResponse: http.IncomingMessage | undefined;
	await rejects(got('', {
		retry: {limit: 0},
		request: async () => new Promise<http.IncomingMessage>((resolve, reject) => {
			http.get(server.url, response => {
				nativeResponse = response;
				resolve(response);
			}).once('error', reject);
		}),
	}), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(nativeResponse?.destroyed, true);
});

test('a rejected decompression keeps the cached response state', withServer, async (_t, server, got) => {
	const response = new Responselike({
		statusCode: 200,
		headers: {'content-encoding': gzipEncodingList(tooManyContentEncodings)},
		body: Buffer.from('body'),
		url: server.url,
	});
	(response as Responselike & {fromCache?: boolean}).fromCache = true;

	const error = await rejects(got('', {
		retry: {limit: 0},
		request: async () => response as unknown as http.IncomingMessage,
	}), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(error.response?.isFromCache, true);
	assert.strictEqual(error.request?.isFromCache, true);
	assert.strictEqual(error.response?.body, undefined);
	assert.strictEqual(error.response?.rawBody, undefined);
});

test('a rejected decompression keeps the revalidated cached response state', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	const etag = '"compressed-body"';
	let requestCount = 0;
	server.get('/', (request, response) => {
		requestCount++;
		response.setHeader('cache-control', 'public, no-cache');
		response.setHeader('etag', etag);
		if (request.headers['if-none-match'] === etag) {
			response.statusCode = 304;
			response.end();
			return;
		}

		response.setHeader('content-encoding', contentEncoding);
		response.end(gzipEncoded(tooManyContentEncodings));
	});

	const client = got.extend({cache: new Map(), retry: {limit: 0}});
	await client('', {decompress: false});

	const error = await rejects(client(''), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(requestCount, 2);
	assert.strictEqual(error.response?.statusCode, 200);
	assert.strictEqual(error.response?.headers['content-encoding'], contentEncoding);
	assert.strictEqual(error.response?.isFromCache, true);
	assert.strictEqual(error.request?.isFromCache, true);
	assert.strictEqual(error.response?.body, undefined);
	assert.strictEqual(error.response?.rawBody, undefined);
});

test('decodes the maximum supported number of content codings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', gzipEncodingList(maxContentEncodings));
		response.end(gzipEncoded(maxContentEncodings));
	});

	assert.strictEqual(await got('').text(), testContent);
});

test('ignores identity codings and empty list elements when counting content codings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', `identity,, ${gzipEncodingList(maxContentEncodings)}`);
		response.end(gzipEncoded(maxContentEncodings));
	});

	assert.strictEqual(await got('').text(), testContent);
});

test('does not reject a long list that contains an unsupported coding', withServer, async (_t, server, got) => {
	const contentEncoding = `${gzipEncodingList(tooManyContentEncodings)}, unknown-coding`;
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', contentEncoding);
		response.end('not decoded');
	});

	const response = await got('');

	assert.strictEqual(response.body, 'not decoded');
	assert.strictEqual(response.headers['content-encoding'], contentEncoding);
});

test('does not reject too many content codings when decompression is disabled', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	const payload = gzipEncoded(tooManyContentEncodings);
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', contentEncoding);
		response.end(payload);
	});

	const response = await got('', {decompress: false, responseType: 'buffer'});

	assert.strictEqual(response.headers['content-encoding'], contentEncoding);
	assert.deepStrictEqual(response.body, new Uint8Array(payload));
});

test('rejects a response with too many content codings after a redirect with an open body', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/final'});
		response.write('open');
	});
	server.get('/final', (_request, response) => {
		response.setHeader('content-encoding', contentEncoding);
		response.end('body');
	});

	const error = await rejects(got('', {retry: {limit: 0}, signal: AbortSignal.timeout(5000)}), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(error.response?.statusCode, 200);
	assert.strictEqual(error.response?.url, `${server.url}/final`);
});

test('honors Retry-After on a response with too many content codings', withServer, async (_t, server, got) => {
	const contentEncoding = gzipEncodingList(tooManyContentEncodings);
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount += 1;
		response.statusCode = 503;
		response.setHeader('content-encoding', contentEncoding);
		response.setHeader('retry-after', '0');
		response.end('body');
	});

	let observedRetryAfter: number | undefined;
	const error = await rejects(got('', {
		retry: {
			limit: 1,
			calculateDelay({retryAfter}) {
				observedRetryAfter = retryAfter;
				return 1;
			},
		},
	}), errorMatching(RequestError, {
		name: 'RequestError',
		message: tooManyContentCodingsMessage,
	}));

	assert.strictEqual(observedRetryAfter, 0);
	assert.strictEqual(requestCount, 2);
	assert.strictEqual(error.response?.headers['retry-after'], '0');
});

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

for (const {encoding, compress} of [
	{encoding: 'deflate', compress: zlib.deflateSync},
	{encoding: 'br', compress: zlib.brotliCompressSync},
]) {
	test(`decodes a single ${encoding} content coding`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('content-encoding', encoding);
			response.end(compress(testContent));
		});

		const response = await got('');

		assert.strictEqual(response.body, testContent);
		assert.deepStrictEqual(response.rawBody, new Uint8Array(Buffer.from(testContent)));
		assert.strictEqual(response.headers['content-encoding'], undefined);
	});

	test(`decodes a single ${encoding} content coding - stream`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('content-encoding', encoding);
			response.end(compress(testContent));
		});

		assert.strictEqual(await getStream(got.stream('')), testContent);
	});
}

test('decompress content on error - stream', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Content-Encoding', 'gzip');
		response.status(404);
		response.end(gzipData);
	});

	const error = await rejects(getStream(got.stream('')), {name: 'HTTPError'});

	assert.strictEqual(error.response.body, testContent);
	assert.deepStrictEqual(error.response.rawBody, new Uint8Array(Buffer.from(testContent)));
});

test('the `encoding` option decodes the decompressed bytes', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end(gzipSync(Buffer.from('café', 'latin1')));
	});

	assert.strictEqual((await got('', {encoding: 'latin1'})).body, 'café');
});

test('disabled decompression returns compressed bytes instead of parsing JSON', withServer, async (_t, server, got) => {
	const payload = gzipSync(JSON.stringify({a: 1}));
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end(payload);
	});

	const {body} = await got('', {decompress: false, responseType: 'json'});

	assert.deepStrictEqual(body, new Uint8Array(payload));
});

test('an empty gzip body parses as an empty JSON response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end(gzipSync(''));
	});

	let parseCount = 0;
	const {body} = await got('', {
		responseType: 'json',
		parseJson(text) {
			parseCount++;
			return JSON.parse(text);
		},
	});

	assert.strictEqual(body, '');
	assert.strictEqual(parseCount, 0);
});

test('passes `unknown-coding` bytes through undecoded', withServer, async (_t, server, got) => {
	const payload = Buffer.from('raw payload');
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'unknown-coding');
		response.end(payload);
	});

	const response = await got('');

	assert.deepStrictEqual(response.rawBody, new Uint8Array(payload));
	assert.strictEqual(response.headers['content-encoding'], 'unknown-coding');
});
