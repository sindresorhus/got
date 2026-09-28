import {Buffer} from 'node:buffer';
import zlib, {
	brotliCompressSync,
	brotliDecompressSync,
	deflateSync,
	gzipSync,
	gunzipSync,
} from 'node:zlib';
import assert from 'node:assert/strict';
import type {Handler} from 'express';
import getStream from 'get-stream';
import ResponseLike from 'responselike';
import {CookieJar} from 'tough-cookie';
import got, {
	HTTPError,
	ParseError,
	ReadError,
	type Response,
} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const dog = {data: 'dog'};
const jsonResponse = JSON.stringify(dog);

const defaultHandler: Handler = (_request, response) => {
	response.end(jsonResponse);
};

test('disabled decompression preserves responses with stacked content encodings', withServer, async (_t, server, got) => {
	const compressed = brotliCompressSync(gzipSync(jsonResponse));
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip, br');
		response.end(compressed);
	});

	const response = await got('', {decompress: false});
	assert.deepStrictEqual(response.body, new Uint8Array(compressed));
	assert.strictEqual(gunzipSync(brotliDecompressSync(response.rawBody)).toString(), jsonResponse);
});

for (const responseType of ['text', 'json', 'buffer'] as const) {
	test(`stacked encodings bypass ${responseType} parsing when decompression is disabled`, withServer, async (_t, server, got) => {
		const compressed = brotliCompressSync(gzipSync(jsonResponse));
		server.get('/', (_request, response) => {
			response.setHeader('content-encoding', 'GZip,\tBR');
			response.end(compressed);
		});

		const body = await got('', {
			decompress: false,
			responseType,
			resolveBodyOnly: true,
			parseJson() {
				assert.fail('Compressed bytes must not reach the JSON parser');
			},
		});

		assert.deepStrictEqual(body, new Uint8Array(compressed));
	});
}

test('HTTP errors retain stacked compressed response bytes when decompression is disabled', withServer, async (_t, server, got) => {
	const compressed = gzipSync(brotliCompressSync(jsonResponse));
	server.get('/', (_request, response) => {
		response.writeHead(400, {'content-encoding': 'br, gzip'});
		response.end(compressed);
	});

	const error = await rejects(got('', {decompress: false, retry: {limit: 0}}), HTTPError);
	assert.deepStrictEqual(error.response.body, new Uint8Array(compressed));
	assert.deepStrictEqual(error.response.rawBody, new Uint8Array(compressed));
});

for (const contentEncoding of [undefined, 'identity']) {
	test(`disabled decompression still parses uncompressed JSON with encoding ${contentEncoding}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			if (contentEncoding !== undefined) {
				response.setHeader('content-encoding', contentEncoding);
			}

			response.end(jsonResponse);
		});

		assert.deepStrictEqual((await got('', {decompress: false, responseType: 'json'})).body, dog);
	});
}

test('`options.resolveBodyOnly` works', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.deepStrictEqual(await got<Record<string, unknown>>({responseType: 'json', resolveBodyOnly: true}), dog);
});

test('`options.resolveBodyOnly` combined with `options.throwHttpErrors`', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('/');
	});

	assert.strictEqual(await got({resolveBodyOnly: true, throwHttpErrors: false}), '/');
});

test('JSON response', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.deepStrictEqual((await got({responseType: 'json'})).body, dog);
});

test('Uint8Array response', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const {body} = await got({responseType: 'buffer'});
	assert.deepStrictEqual(body, new TextEncoder().encode(jsonResponse));
	assert.strictEqual(body instanceof Uint8Array, true);
	assert.strictEqual(Buffer.isBuffer(body), false);
});

test('rawBody is compatible with web APIs', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const {rawBody} = await got({responseType: 'text'});
	assert.strictEqual(rawBody.buffer instanceof ArrayBuffer, true);
	assert.strictEqual(await new Blob([rawBody]).text(), jsonResponse);
	assert.strictEqual(await new Response(rawBody).text(), jsonResponse);
});

test('Text response', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.strictEqual((await got({responseType: 'text'})).body, jsonResponse);
});

test('Text response #2', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.strictEqual((await got({responseType: undefined})).body, jsonResponse);
});

test('Text response strips UTF-8 BOM', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('hello')]));
	});

	assert.strictEqual((await got({responseType: 'text'})).body, 'hello');
});

test('Text response shortcut strips UTF-8 BOM', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('hello')]));
	});

	assert.strictEqual(await got('').text(), 'hello');
});

test('JSON response - promise.json()', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.deepStrictEqual(await got('').json(), dog);
});

test('Uint8Array response - promise.buffer()', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const body = await got('').buffer();
	assert.deepStrictEqual(body, new TextEncoder().encode(jsonResponse));
	assert.strictEqual(body instanceof Uint8Array, true);
	assert.strictEqual(Buffer.isBuffer(body), false);
});

test('Text response - promise.text()', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.strictEqual(await got('').text(), jsonResponse);
});

test('Text response - promise.json().text()', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.strictEqual(await got('').json().text(), jsonResponse);
});

test('works if promise has been already resolved', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const promise = got('').text();
	assert.strictEqual(await promise, jsonResponse);
	assert.deepStrictEqual(await promise.json(), dog);
});

test('throws an error on invalid response type', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	// @ts-expect-error Error tests
	const error = await rejects(got({responseType: 'invalid'}));
	assert.strictEqual(error?.message, 'Invalid `responseType` option: invalid');
});

test('wraps parsing errors', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('/');
	});

	const error = await rejects(got({responseType: 'json'}), ParseError);
	assert.strictEqual(error?.message.includes((error.options.url as URL).hostname), true);
	assert.strictEqual((error?.options.url as URL).pathname, '/');
	assert.strictEqual(error?.code, 'ERR_BODY_PARSE_FAILURE');
});

test('credentials are stripped from ParseError message URL', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('/');
	});

	const url = new URL(server.url);
	url.username = 'user';
	url.password = 'secret';

	const error = await rejects(got(url, {responseType: 'json'}), ParseError);
	assert.strictEqual(error?.message.includes('user'), false);
	assert.strictEqual(error?.message.includes('secret'), false);
	assert.match(error?.message ?? '', /in "http:\/\/localhost:\d+\/"$/v);
});

test('JSON response with UTF-8 BOM is parsed', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from(jsonResponse)]));
	});

	assert.deepStrictEqual((await got({responseType: 'json'})).body, dog);
	assert.deepStrictEqual(await got('').json(), dog);
});

test('parses non-200 responses', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end(jsonResponse);
	});

	const error = await rejects(got({responseType: 'json', retry: {limit: 0}}), HTTPError);
	assert.deepStrictEqual(error?.response.body, dog);
});

test('ignores errors on invalid non-200 responses', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('Internal error');
	});

	const error = await rejects(got({responseType: 'json', retry: {limit: 0}}), errorMatching(HTTPError, {message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/v}));

	assert.strictEqual(error?.response.body, 'Internal error');
	assert.strictEqual((error?.options.url as URL).pathname, '/');
});

test('parse errors have `response` property', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('/');
	});

	const error = await rejects(got({responseType: 'json'}), ParseError);

	assert.strictEqual(error?.response.statusCode, 200);
	assert.strictEqual(error?.response.body, '/');
	assert.strictEqual(error?.code, 'ERR_BODY_PARSE_FAILURE');
});

test('sets correct headers', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		response.end(JSON.stringify(request.headers));
	});

	const {body: headers} = await got.post<Record<string, string>>({responseType: 'json', json: {}});
	assert.strictEqual(headers['content-type'], 'application/json');
	assert.strictEqual(headers.accept, 'application/json');
});

test('doesn\'t throw on 204 No Content', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 204;
		response.end();
	});

	const body = await got('').json();
	assert.strictEqual(body, '');
});

test('doesn\'t throw on empty bodies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end();
	});

	const body = await got('').json();
	assert.strictEqual(body, '');
});

test('.buffer() returns binary content', withServer, async (_t, server, got) => {
	const body = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');

	server.get('/', (_request, response) => {
		response.end(body);
	});

	const buffer = await got('').buffer();
	assert.strictEqual(Buffer.compare(buffer, body), 0);
});

test('shortcuts throw ParseErrors', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('not a json');
	});
	await assert.rejects(got('').json(), errorMatching(ParseError, {message: /^Unexpected token/v, code: 'ERR_BODY_PARSE_FAILURE'}));
});

test('shortcuts result properly when retrying in afterResponse', withServer, async (_t, server, got) => {
	const nasty = JSON.stringify({hello: 'nasty'});
	const proper = JSON.stringify({hello: 'world'});

	server.get('/', (request, response) => {
		if (request.headers.token === 'unicorn') {
			response.end(proper);
		} else {
			response.statusCode = 401;
			response.end(nasty);
		}
	});

	const promise = got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
		},
	});

	const json = await promise.json<{hello: string}>();
	const text = await promise.text();
	const buffer = await promise.buffer();

	assert.strictEqual(json.hello, 'world');
	assert.strictEqual(text, proper);
	assert.strictEqual(Buffer.from(buffer).compare(Buffer.from(proper)), 0);
});

test('responseType is optional when using template', withServer, async (_t, server, got) => {
	const data = {hello: 'world'};

	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});

	const jsonClient = got.extend({responseType: 'json'});
	const {body} = await jsonClient.post<typeof data>('', {json: data});

	assert.deepStrictEqual(body, data);
});

test('JSON response custom parser', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.deepStrictEqual((await got({
		responseType: 'json',
		parseJson: text => ({...JSON.parse(text), custom: 'parser'}),
	})).body, {...dog, custom: 'parser'});
});

test.serial('incrementally decodes UTF-8 text response while downloading', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	let responseEnded = false;
	let streamDecodeCallCount = 0;
	let decodedBeforeResponseEnded = false;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (options?.stream) {
			streamDecodeCallCount++;
			if (!responseEnded) {
				decodedBeforeResponseEnded = true;
			}
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.write('hello ');

		setTimeout(() => {
			responseEnded = true;
			response.end('world');
		}, 25);
	});

	try {
		const {body} = await got({responseType: 'text'});
		assert.strictEqual(body, 'hello world');
		assert.strictEqual(streamDecodeCallCount > 0, true);
		assert.strictEqual(decodedBeforeResponseEnded, true);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('incrementally decodes UTF-8 JSON response while downloading', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	let responseEnded = false;
	let streamDecodeCallCount = 0;
	let decodedBeforeResponseEnded = false;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (options?.stream) {
			streamDecodeCallCount++;
			if (!responseEnded) {
				decodedBeforeResponseEnded = true;
			}
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.write('{"hello":"');

		setTimeout(() => {
			responseEnded = true;
			response.end('world"}');
		}, 300);
	});

	try {
		const {body} = await got<{hello: string}>({responseType: 'json'});
		assert.deepStrictEqual(body, {hello: 'world'});
		assert.strictEqual(streamDecodeCallCount > 0, true);
		assert.strictEqual(decodedBeforeResponseEnded, true);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('falls back to buffered decode when incremental decode throws', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	const payload = {hello: 'world'};
	let thrown = false;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (!thrown && options?.stream) {
			thrown = true;
			throw new TypeError('Injected decode failure');
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.end(JSON.stringify(payload));
	});

	try {
		const {body} = await got<typeof payload>({responseType: 'json'});
		assert.strictEqual(thrown, true);
		assert.deepStrictEqual(body, payload);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('falls back to buffered decode when incremental decoder final flush throws', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	const payload = {hello: 'world'};
	let thrown = false;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (!thrown && options === undefined) {
			thrown = true;
			throw new TypeError('Injected final flush decode failure');
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.end(JSON.stringify(payload));
	});

	try {
		const {body} = await got<typeof payload>({responseType: 'json'});
		assert.strictEqual(thrown, true);
		assert.deepStrictEqual(body, payload);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('does not incrementally decode for non-UTF-8 encoding', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	const payload = 'a'.repeat(1024);
	let streamDecodeCallCount = 0;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (options?.stream) {
			streamDecodeCallCount++;
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.end(payload);
	});

	try {
		const {body} = await got({
			responseType: 'text',
			encoding: 'base64',
		});

		assert.strictEqual(body, Buffer.from(payload).toString('base64'));
		assert.strictEqual(streamDecodeCallCount, 0);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('incrementally decodes for case-insensitive UTF-8 encoding names', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	const payload = 'hello world';
	const encoding = Buffer.from([85, 84, 70, 45, 56]).toString() as BufferEncoding;
	let streamDecodeCallCount = 0;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (options?.stream) {
			streamDecodeCallCount++;
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.end(payload);
	});

	try {
		const encodingWithoutHyphen = Buffer.from([85, 84, 70, 56]).toString() as BufferEncoding;
		const responses = await Promise.all([
			got({
				responseType: 'text',
				encoding,
			}),
			got({
				responseType: 'text',
				encoding: encodingWithoutHyphen,
			}),
		]);

		for (const response of responses) {
			assert.strictEqual(response.body, payload);
		}

		assert.strictEqual(streamDecodeCallCount > 0, true);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('does not incrementally decode in stream mode', withServer, async (_t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		return;
	}

	const originalDecode = TextDecoder.prototype.decode;
	let streamDecodeCallCount = 0;

	TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
		if (options?.stream) {
			streamDecodeCallCount++;
		}

		return originalDecode.call(this, input, options);
	};

	server.get('/', (_request, response) => {
		response.end('hello');
	});

	try {
		await new Promise<void>((resolve, reject) => {
			const streamRequest = got.stream({responseType: 'text'});
			streamRequest.on('error', reject);
			streamRequest.on('end', resolve);
			streamRequest.resume();
		});

		assert.strictEqual(streamDecodeCallCount, 0);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test('JSON shortcut reads mutations made through the buffer shortcut', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{"value":1}');
	});

	const promise = got('');
	const buffer = await promise.buffer();
	buffer[9] = '2'.codePointAt(0)!;

	assert.deepStrictEqual(await promise.json(), {value: 2});
});

for (const responseType of ['text', 'json', 'buffer'] as const) {
	test(`shortcuts read repeated rawBody mutations after a ${responseType} response`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('{"value":1}');
		});

		const promise = got('', {responseType});
		const response = await promise as Response;
		const buffer = await promise.buffer();
		assert.strictEqual(buffer, response.rawBody);

		for (const value of [2, 3]) {
			buffer[9] = String(value).codePointAt(0)!;
			// eslint-disable-next-line no-await-in-loop
			assert.deepStrictEqual(await promise.json(), {value});
			// eslint-disable-next-line no-await-in-loop
			assert.strictEqual(await promise.text(), `{"value":${value}}`);
		}

		buffer[9] = 'x'.codePointAt(0)!;
		await assert.rejects(promise.json(), ParseError);
	});
}

test('JSON parse failures preserve the configured response encoding', withServer, async (_t, server, got) => {
	const body = 'Invalid JSON: café';
	server.get('/', (_request, response) => {
		response.end(Buffer.from(body, 'utf16le'));
	});

	const error = await rejects(got('', {
		responseType: 'json',
		encoding: 'utf16le',
		retry: {limit: 0},
	}), ParseError);

	assert.strictEqual(error?.response.body, body);
});

for (const encoding of ['utf16le', 'latin1', 'utf8'] as const) {
	for (const throwHttpErrors of [true, false]) {
		test(`invalid JSON HTTP errors preserve ${encoding} text with throwHttpErrors=${throwHttpErrors}`, withServer, async (_t, server, got) => {
			const body = 'Service indisponible: café';
			const rawBody = Buffer.from(body, encoding);
			server.get('/', (_request, response) => {
				response.statusCode = 400;
				response.end(rawBody);
			});

			const promise = got('', {responseType: 'json', encoding, throwHttpErrors});
			const response = throwHttpErrors
				? (await rejects(promise, HTTPError)).response
				: await promise;

			assert.strictEqual(response.body, body);
			assert.deepStrictEqual(response.rawBody, new Uint8Array(rawBody));
			assert.strictEqual(response.statusCode, 400);
		});
	}
}

test('text responses strip their UTF-8 BOM when storing cookies', withServer, async (_t, server, got) => {
	const body = '\u{FEFF}hello';
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'session=value');
		response.end(body);
	});

	const response = await got('', {
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {},
		},
	});

	assert.strictEqual(response.body, 'hello');
});

for (const encoding of ['utf8', 'utf16le', 'latin1'] as const) {
	test(`cookie storage preserves ${encoding} response text and raw bytes`, withServer, async (_t, server, got) => {
		const body = encoding === 'latin1' ? 'café' : '\u{FEFF}café 🦄';
		const bytes = Buffer.from(body, encoding);
		const storedCookies: string[] = [];
		server.get('/', (_request, response) => {
			response.setHeader('set-cookie', ['first=one', 'second=two']);
			response.end(bytes);
		});

		const promise = got('', {
			encoding,
			cookieJar: {
				async getCookieString() {
					return '';
				},
				async setCookie(cookie: string) {
					storedCookies.push(cookie);
				},
			},
		});

		const decoded = encoding === 'latin1' ? body : body.slice(1);
		assert.strictEqual((await promise).body, decoded);
		assert.deepStrictEqual(await promise.buffer(), new Uint8Array(bytes));
		assert.strictEqual(await promise.text(), decoded);
		assert.deepStrictEqual(storedCookies, ['first=one', 'second=two']);
	});
}

test('empty text responses remain empty when storing cookies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'session=value');
		response.end();
	});

	const body = await got('', {
		resolveBodyOnly: true,
		cookieJar: {
			async getCookieString() {
				return '';
			},
			async setCookie() {},
		},
	});

	assert.strictEqual(body, '');
});

test('custom JSON parser failures preserve thrown string messages', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const error = await rejects(got('', {
		responseType: 'json',
		parseJson() {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw 'Parser rejected this document';
		},
	}), ParseError);

	assert.strictEqual(error.message.startsWith('Parser rejected this document'), true);
});

for (const thrown of [undefined, null, 42]) {
	for (const useShortcut of [true, false]) {
		test(`custom JSON parser wraps ${String(thrown)} with shortcut=${useShortcut}`, withServer, async (_t, server, got) => {
			server.get('/', (_request, response) => {
				response.end('{}');
			});

			const promise = got('', {
				responseType: useShortcut ? 'text' : 'json',
				parseJson() {
					// eslint-disable-next-line @typescript-eslint/only-throw-error
					throw thrown;
				},
			});
			const error = await rejects(useShortcut ? promise.json() : promise, ParseError);

			assert.strictEqual(error.message.startsWith(`${String(thrown)} in `), true);
			assert.strictEqual(error.code, 'ERR_BODY_PARSE_FAILURE');
			assert.strictEqual(error.response.statusCode, 200);
			assert.strictEqual(error.response.body, '{}');
		});
	}
}

for (const thrown of [new Error('Parser failed'), {name: 'ParserError', message: 'Parser failed'}]) {
	test(`custom JSON parser preserves ${thrown.name} as its cause`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('{}');
		});

		const error = await rejects(got('', {
			parseJson() {
				throw thrown;
			},
		}).json(), ParseError);

		assert.strictEqual(error.cause, thrown);
		assert.strictEqual(error.message.startsWith('Parser failed in '), true);
	});
}

test('text shortcuts consume only the encoding BOM', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('\u{FEFF}\u{FEFF}hello');
	});
	const request = got('');
	const bytes = await request.buffer();
	assert.strictEqual(await request.text(), new TextDecoder().decode(bytes));
	assert.strictEqual(await request.text().text(), '\u{FEFF}hello');
});

for (const encoding of ['utf8', 'utf-8'] as const) { // eslint-disable-line unicorn/text-encoding-identifier-case -- Exercise both supported UTF-8 aliases.
	test(`text shortcuts preserve content after the BOM with ${encoding}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('\u{FEFF}\u{FEFF}hello');
		});

		assert.strictEqual(await got('', {encoding}).text(), '\u{FEFF}hello');
	});
}

for (const body of ['', '\u{FEFF}', 'hello\u{FEFF}world']) {
	test(`text shortcuts preserve empty and embedded-BOM content ${JSON.stringify(body)}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end(body);
		});
		const expected = body === '\u{FEFF}' ? '' : body;

		assert.strictEqual(await got('').text(), expected);
	});
}

test('UTF-16 text shortcuts strip one BOM', withServer, async (_t, server, got) => {
	const body = '\u{FEFF}\u{FEFF}hello';
	server.get('/', (_request, response) => {
		response.end(Buffer.from(body, 'utf16le'));
	});

	const request = got('', {encoding: 'utf16le'});
	assert.strictEqual((await request).body, '\u{FEFF}hello');
	assert.strictEqual(await request.text(), '\u{FEFF}hello');
});

test('shortcuts parse the replacement response returned by an asynchronous handler', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.json({original: true});
	});
	const body = JSON.stringify({replacement: true});
	const client = got.extend({
		handlers: [async (options, next) => {
			const response = await next(options);
			return Object.assign(Object.create(response) as typeof response, {
				body,
				rawBody: new TextEncoder().encode(body),
			});
		}],
	});
	const promise = client('');

	assert.strictEqual((await promise).body, body);
	assert.deepStrictEqual(await promise.json(), {replacement: true});
	assert.strictEqual(await promise.text(), body);
	assert.deepStrictEqual(await promise.buffer(), new TextEncoder().encode(body));
	assert.strictEqual(await promise.json().text(), body);
	assert.deepStrictEqual(await promise.buffer().json(), {replacement: true});
});

test('shortcuts use a parse error response recovered by a handler', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('invalid JSON');
	});
	const client = got.extend({
		responseType: 'json',
		handlers: [async (options, next) => {
			try {
				return await next(options);
			} catch (error) {
				if (error instanceof ParseError) {
					return error.response as Awaited<ReturnType<typeof next>>;
				}

				throw error;
			}
		}],
	});
	const promise = client('');
	const response = await promise;

	assert.strictEqual(response.body, 'invalid JSON');
	assert.strictEqual(await promise.text(), 'invalid JSON');
	assert.deepStrictEqual(await promise.buffer(), new TextEncoder().encode('invalid JSON'));
	const error = await rejects(promise.json(), ParseError);
	assert.strictEqual(error.response, response);
});

test('shortcuts do not treat body-only objects as handler replacement responses', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.json({original: true});
	});
	const promise = got('', {
		resolveBodyOnly: true,
		hooks: {
			afterResponse: [response => {
				response.body = {
					request: response.request,
					rawBody: new TextEncoder().encode('different content'),
				};
				return response;
			}],
		},
	});

	assert.strictEqual(await promise.text(), JSON.stringify({original: true}));
	assert.deepStrictEqual(await promise.json(), {original: true});
});

test('automatically decodes stacked content encodings in reverse order', withServer, async (_t, server, got) => {
	const compressed = brotliCompressSync(gzipSync(jsonResponse));
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br', 'content-type': 'application/json'});
		response.end(compressed);
	});

	const response = await got('', {responseType: 'json'});
	assert.deepStrictEqual(response.body, dog);
	assert.deepStrictEqual(response.rawBody, new TextEncoder().encode(jsonResponse));
});

for (const {encoding, compressed} of [
	{encoding: 'br, gzip', compressed: gzipSync(brotliCompressSync(jsonResponse))},
	{encoding: 'gzip, gzip', compressed: gzipSync(gzipSync(jsonResponse))},
	{encoding: 'deflate, br', compressed: brotliCompressSync(deflateSync(jsonResponse))},
	{encoding: 'GZip,\tBR', compressed: brotliCompressSync(gzipSync(jsonResponse))},
]) {
	test(`decodes stacked ${encoding} responses and validates their compressed length`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': encoding, 'content-length': compressed.length, 'x-metadata': 'preserved'});
			response.end(compressed);
		});

		const response = await got('', {responseType: 'json', strictContentLength: true});
		assert.deepStrictEqual(response.body, dog);
		assert.deepStrictEqual(response.rawBody, new TextEncoder().encode(jsonResponse));
		assert.strictEqual(response.headers['content-encoding'], undefined);
		assert.strictEqual(response.headers['content-length'], undefined);
		assert.strictEqual(response.headers['x-metadata'], 'preserved');
		assert.strictEqual(response.rawHeaders.includes(String(compressed.length)), true);
	});
}

test('streams stacked encoded responses with decoded bytes', withServer, async (_t, server, got) => {
	const compressed = brotliCompressSync(gzipSync('café 🦄'));
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br', 'content-length': compressed.length});
		response.write(compressed.subarray(0, 5));
		response.end(compressed.subarray(5));
	});

	assert.strictEqual(await getStream(got.stream('')), 'café 🦄');
});

for (const {name, compressed} of [
	{name: 'outer', compressed: Buffer.from('invalid gzip')},
	{name: 'inner', compressed: gzipSync(Buffer.from('invalid gzip'))},
]) {
	test(`stacked decoding reports a corrupt ${name} layer`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': 'gzip, gzip'});
			response.end(compressed);
		});

		const error = await rejects(got('', {retry: {limit: 0}, timeout: {request: 10_000}}), ReadError);
		assert.strictEqual(error.code, 'ERR_READING_RESPONSE_STREAM');
		assert.strictEqual(error.message.includes('incorrect header check'), true);
	});
}

for (const encoding of ['unknown, gzip', 'gzip, unknown']) {
	test(`leaves ${encoding} completely encoded`, withServer, async (_t, server, got) => {
		const compressed = gzipSync(jsonResponse);
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': encoding, 'content-length': compressed.length});
			response.end(compressed);
		});

		const response = await got('', {responseType: 'buffer'});
		assert.deepStrictEqual(response.body, new Uint8Array(compressed));
		assert.strictEqual(response.headers['content-encoding'], encoding);
		assert.strictEqual(response.headers['content-length'], String(compressed.length));
	});
}

test('stacked decoding returns binary bodies without text conversion', withServer, async (_t, server, got) => {
	const bytes = Uint8Array.of(0, 255, 128, 13, 10);
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br'});
		response.end(brotliCompressSync(gzipSync(bytes)));
	});

	assert.deepStrictEqual(await got('').buffer(), bytes);
});

test('stacked decoding includes zstd when supported by Node.js', withServer, async (_t, server, got) => {
	if (typeof zlib.zstdCompressSync !== 'function') {
		return;
	}

	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, zstd'});
		response.end(zlib.zstdCompressSync(gzipSync(jsonResponse)));
	});

	assert.deepStrictEqual(await got('').json(), dog);
});

test('stacked decoding still rejects truncated compressed transfers', withServer, async (_t, server, got) => {
	const compressed = brotliCompressSync(gzipSync(jsonResponse));
	server.get('/', (request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br', 'content-length': compressed.length + 1});
		response.end(compressed, () => {
			request.socket.end();
		});
	});

	const error = await rejects(got('', {retry: {limit: 0}, timeout: {request: 10_000}}), ReadError);
	assert.strictEqual(error.code, 'ERR_HTTP_CONTENT_LENGTH_MISMATCH');
});

for (const {method, statusCode} of [{method: 'HEAD', statusCode: 200}, {method: 'GET', statusCode: 204}, {method: 'GET', statusCode: 304}]) {
	test(`stacked encoding metadata is not decoded for ${method} ${statusCode}`, withServer, async (_t, server, got) => {
		server.all('/', (_request, response) => {
			response.writeHead(statusCode, {'content-encoding': 'gzip, br'});
			response.end();
		});
		const response = await got('', {method, headers: {'if-none-match': '"version"'}});

		assert.strictEqual(response.body, '');
		assert.strictEqual(response.headers['content-encoding'], 'gzip, br');
	});
}

test('followed redirects ignore invalid stacked encoded bodies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/next', 'content-encoding': 'gzip, br'});
		response.end('invalid compressed body');
	});
	server.get('/next', defaultHandler);

	const response = await got('', {responseType: 'json'});
	assert.deepStrictEqual(response.body, dog);
	assert.strictEqual(response.redirectUrls.length, 1);
});

for (const encoding of ['utf8', 'latin1', 'utf16le'] as const) {
	for (const useCookieJar of [false, true]) {
		test(`preserves bytes from a custom response decoded as ${encoding} with cookie jar ${useCookieJar}`, async _t => {
			const bytes = Buffer.from('café', encoding);
			const response = await got('https://example.com', {
				encoding,
				cookieJar: useCookieJar
					? {
						async getCookieString() {
							return '';
						},
						async setCookie() {},
					}
					: undefined,
				hooks: {
					beforeRequest: [() => {
						const response = new ResponseLike({
							statusCode: 200,
							headers: {'content-length': String(bytes.length)},
							body: bytes,
							url: 'https://example.com',
						});
						Object.assign(response.headers, {'set-cookie': ['session=value']});
						response.setEncoding(encoding);
						return response;
					}],
				},
			});

			assert.strictEqual(response.body, 'café');
			assert.deepStrictEqual(response.rawBody, new Uint8Array(bytes));
			assert.strictEqual(response.request.downloadProgress.transferred, bytes.length);
		});
	}
}

const payload = '﻿{"hello":"世界"}';

// eslint-disable-next-line unicorn/text-encoding-identifier-case -- Verify all supported UTF-8 aliases.
for (const encoding of [undefined, 'utf8', 'utf-8', 'UTF-8'] as const) {
	for (const shortcut of [false, true]) {
		test(`JSON parser receives BOM-stripped text with and without cookies: ${encoding ?? 'default'}, shortcut=${shortcut}`, withServer, async (_t, server, got) => {
			server.get('/', (_request, response) => {
				response.setHeader('set-cookie', 'hello=world');
				response.end(payload);
			});

			const inputs: string[] = [];
			for (const cookieJar of [undefined, new CookieJar()]) {
				const options = {
					cookieJar,
					encoding: encoding as BufferEncoding | undefined,
					parseJson(text: string) {
						inputs.push(text);
						return JSON.parse(text) as unknown;
					},
				};
				const request = shortcut ? got(options).json() : got({...options, responseType: 'json', resolveBodyOnly: true});
				// eslint-disable-next-line no-await-in-loop -- Preserve parser input order for comparison.
				const body = await request;

				assert.deepStrictEqual(body, {hello: '世界'});
			}

			assert.deepStrictEqual(inputs, [payload.slice(1), payload.slice(1)]);
		});
	}
}

for (const shortcut of [false, true]) {
	for (const useCookieJar of [false, true]) {
		test(`default JSON parser accepts a BOM: cookies=${useCookieJar}, shortcut=${shortcut}`, withServer, async (_t, server, got) => {
			server.get('/', (_request, response) => {
				response.setHeader('set-cookie', 'hello=world');
				response.end(payload);
			});

			const options = {cookieJar: useCookieJar ? new CookieJar() : undefined};
			const body = shortcut ? await got(options).json() : (await got({...options, responseType: 'json'})).body;
			assert.deepStrictEqual(body, {hello: '世界'});
		});
	}
}

test('empty JSON response with cookies does not call the parser', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const options = {
		cookieJar: new CookieJar(),
		parseJson() {
			assert.fail('Empty bodies must not be parsed');
		},
	};

	assert.strictEqual((await got({...options, responseType: 'json'})).body, '');
	assert.strictEqual(await got(options).json(), '');
});

test('JSON parser receives BOM-stripped UTF-16 text with cookies', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end(Buffer.from(payload, 'utf16le'));
	});

	const inputs: string[] = [];
	const options = {
		cookieJar: new CookieJar(),
		encoding: 'utf16le' as const,
		parseJson(text: string) {
			inputs.push(text);
			return JSON.parse(text) as unknown;
		},
	};

	assert.deepStrictEqual((await got({...options, responseType: 'json'})).body, {hello: '世界'});
	assert.deepStrictEqual(await got(options).json(), {hello: '世界'});
	assert.deepStrictEqual(inputs, [payload.slice(1), payload.slice(1)]);
});

// `identity` is a valid coding that adds no decoding step, and empty list members are
// ignored (RFC 9110, sections 8.4.1 and 5.6.1.1).
for (const contentEncoding of ['gzip, identity', 'identity, gzip', 'gzip,', 'gzip, ', 'GZip, IDENTITY']) {
	test(`decompresses a ${JSON.stringify(contentEncoding)} content-encoding`, withServer, async (_t, server, got) => {
		const compressed = gzipSync(jsonResponse);
		server.get('/', (_request, response) => {
			response.setHeader('content-encoding', contentEncoding);
			response.end(compressed);
		});

		const response = await got('');

		assert.strictEqual(response.body, jsonResponse);
		assert.strictEqual(response.headers['content-encoding'], undefined);
	});
}

test('leaves an identity-only content-encoding untouched', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'identity');
		response.end(jsonResponse);
	});

	const response = await got('');

	assert.strictEqual(response.body, jsonResponse);
	assert.strictEqual(response.headers['content-encoding'], 'identity');
});

// An unusable encoding is reported as a `ParseError` with the response attached, even when
// the main promise already read the body as a buffer.
for (const shortcut of ['text', 'json'] as const) {
	test(`an unusable encoding is a ParseError for the ${shortcut} shortcut`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('{}');
		});

		const promise = got('', {
			responseType: 'buffer',
			// Only a runtime check can reach an encoding Node does not know.
			encoding: 'nonsense' as BufferEncoding,
		});
		const error = await rejects(promise[shortcut](), ParseError);

		assert.match(error?.message ?? '', /Unknown encoding/v);
		assert.strictEqual(error?.response.statusCode, 200);
	});
}
