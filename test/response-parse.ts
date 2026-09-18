import {Buffer} from 'node:buffer';
import zlib, {
	brotliCompressSync, brotliDecompressSync, deflateSync, gzipSync, gunzipSync,
} from 'node:zlib';
import test from 'ava';
import type {Handler} from 'express';
import getStream from 'get-stream';
import ResponseLike from 'responselike';
import {CookieJar} from 'tough-cookie';
import got, {
	HTTPError, ParseError, ReadError, type Response,
} from '../source/index.js';
import withServer from './helpers/with-server.js';

const dog = {data: 'dog'};
const jsonResponse = JSON.stringify(dog);

const defaultHandler: Handler = (_request, response) => {
	response.end(jsonResponse);
};

test('disabled decompression preserves responses with stacked content encodings', withServer, async (t, server, got) => {
	const compressed = brotliCompressSync(gzipSync(jsonResponse));
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip, br');
		response.end(compressed);
	});

	const response = await got('', {decompress: false});
	t.deepEqual(response.body, new Uint8Array(compressed));
	t.is(gunzipSync(brotliDecompressSync(response.rawBody)).toString(), jsonResponse);
});

for (const responseType of ['text', 'json', 'buffer'] as const) {
	test(`stacked encodings bypass ${responseType} parsing when decompression is disabled`, withServer, async (t, server, got) => {
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
				t.fail('Compressed bytes must not reach the JSON parser');
			},
		});

		t.deepEqual(body, new Uint8Array(compressed));
	});
}

test('HTTP errors retain stacked compressed response bytes when decompression is disabled', withServer, async (t, server, got) => {
	const compressed = gzipSync(brotliCompressSync(jsonResponse));
	server.get('/', (_request, response) => {
		response.writeHead(400, {'content-encoding': 'br, gzip'});
		response.end(compressed);
	});

	const error = await t.throwsAsync<HTTPError>(got('', {decompress: false, retry: {limit: 0}}), {instanceOf: HTTPError});
	t.deepEqual(error.response.body, new Uint8Array(compressed));
	t.deepEqual(error.response.rawBody, new Uint8Array(compressed));
});

for (const contentEncoding of [undefined, 'identity']) {
	test(`disabled decompression still parses uncompressed JSON with encoding ${contentEncoding}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			if (contentEncoding !== undefined) {
				response.setHeader('content-encoding', contentEncoding);
			}

			response.end(jsonResponse);
		});

		t.deepEqual((await got('', {decompress: false, responseType: 'json'})).body, dog);
	});
}

test('`options.resolveBodyOnly` works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got<Record<string, unknown>>({responseType: 'json', resolveBodyOnly: true}), dog);
});

test('`options.resolveBodyOnly` combined with `options.throwHttpErrors`', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('/');
	});

	t.is(await got({resolveBodyOnly: true, throwHttpErrors: false}), '/');
});

test('JSON response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual((await got({responseType: 'json'})).body, dog);
});

test('Uint8Array response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const {body} = await got({responseType: 'buffer'});
	t.deepEqual(body, new TextEncoder().encode(jsonResponse));
	t.true(body instanceof Uint8Array);
	t.false(Buffer.isBuffer(body));
});

test('rawBody is compatible with web APIs', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const {rawBody} = await got({responseType: 'text'});
	t.true(rawBody.buffer instanceof ArrayBuffer);
	t.is(await new Blob([rawBody]).text(), jsonResponse);
	t.is(await new Response(rawBody).text(), jsonResponse);
});

test('Text response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is((await got({responseType: 'text'})).body, jsonResponse);
});

test('Text response #2', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is((await got({responseType: undefined})).body, jsonResponse);
});

test('Text response strips UTF-8 BOM', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('hello')]));
	});

	t.is((await got({responseType: 'text'})).body, 'hello');
});

test('Text response shortcut strips UTF-8 BOM', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('hello')]));
	});

	t.is(await got('').text(), 'hello');
});

test('JSON response - promise.json()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got('').json(), dog);
});

test('Uint8Array response - promise.buffer()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const body = await got('').buffer();
	t.deepEqual(body, new TextEncoder().encode(jsonResponse));
	t.true(body instanceof Uint8Array);
	t.false(Buffer.isBuffer(body));
});

test('Text response - promise.text()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is(await got('').text(), jsonResponse);
});

test('Text response - promise.json().text()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is(await got('').json().text(), jsonResponse);
});

test('works if promise has been already resolved', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const promise = got('').text();
	t.is(await promise, jsonResponse);
	t.deepEqual(await promise.json(), dog);
});

test('throws an error on invalid response type', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	// @ts-expect-error Error tests
	const error = await t.throwsAsync<ParseError>(got({responseType: 'invalid'}));
	t.is(error?.message, 'Invalid `responseType` option: invalid');
});

test('wraps parsing errors', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('/');
	});

	const error = await t.throwsAsync<ParseError>(got({responseType: 'json'}), {instanceOf: ParseError});
	t.true(error?.message.includes((error.options.url as URL).hostname));
	t.is((error?.options.url as URL).pathname, '/');
	t.is(error?.code, 'ERR_BODY_PARSE_FAILURE');
});

test('credentials are stripped from ParseError message URL', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('/');
	});

	const url = new URL(server.url);
	url.username = 'user';
	url.password = 'secret';

	const error = await t.throwsAsync<ParseError>(got(url, {responseType: 'json'}), {instanceOf: ParseError});
	t.false(error?.message.includes('user'));
	t.false(error?.message.includes('secret'));
	t.regex(error?.message ?? '', /in "http:\/\/localhost:\d+\/"$/v);
});

test('JSON response with UTF-8 BOM is parsed', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from(jsonResponse)]));
	});

	t.deepEqual((await got({responseType: 'json'})).body, dog);
	t.deepEqual(await got('').json(), dog);
});

test('parses non-200 responses', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end(jsonResponse);
	});

	const error = await t.throwsAsync<HTTPError>(got({responseType: 'json', retry: {limit: 0}}), {instanceOf: HTTPError});
	t.deepEqual(error?.response.body, dog);
});

test('ignores errors on invalid non-200 responses', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('Internal error');
	});

	const error = await t.throwsAsync<HTTPError>(got({responseType: 'json', retry: {limit: 0}}), {
		instanceOf: HTTPError,
		message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/v,
	});

	t.is(error?.response.body, 'Internal error');
	t.is((error?.options.url as URL).pathname, '/');
});

test('parse errors have `response` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('/');
	});

	const error = await t.throwsAsync<ParseError>(got({responseType: 'json'}), {instanceOf: ParseError});

	t.is(error?.response.statusCode, 200);
	t.is(error?.response.body, '/');
	t.is(error?.code, 'ERR_BODY_PARSE_FAILURE');
});

test('sets correct headers', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		response.end(JSON.stringify(request.headers));
	});

	const {body: headers} = await got.post<Record<string, string>>({responseType: 'json', json: {}});
	t.is(headers['content-type'], 'application/json');
	t.is(headers.accept, 'application/json');
});

test('doesn\'t throw on 204 No Content', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 204;
		response.end();
	});

	const body = await got('').json();
	t.is(body, '');
});

test('doesn\'t throw on empty bodies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end();
	});

	const body = await got('').json();
	t.is(body, '');
});

test('.buffer() returns binary content', withServer, async (t, server, got) => {
	const body = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');

	server.get('/', (_request, response) => {
		response.end(body);
	});

	const buffer = await got('').buffer();
	t.is(Buffer.compare(buffer, body), 0);
});

test('shortcuts throw ParseErrors', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('not a json');
	});

	await t.throwsAsync(got('').json(), {
		instanceOf: ParseError,
		message: /^Unexpected token/v,
		code: 'ERR_BODY_PARSE_FAILURE',
	});
});

test('shortcuts result properly when retrying in afterResponse', withServer, async (t, server, got) => {
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

	t.is(json.hello, 'world');
	t.is(text, proper);
	t.is(Buffer.from(buffer).compare(Buffer.from(proper)), 0);
});

test('responseType is optional when using template', withServer, async (t, server, got) => {
	const data = {hello: 'world'};

	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});

	const jsonClient = got.extend({responseType: 'json'});
	const {body} = await jsonClient.post<typeof data>('', {json: data});

	t.deepEqual(body, data);
});

test('JSON response custom parser', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual((await got({
		responseType: 'json',
		parseJson: text => ({...JSON.parse(text), custom: 'parser'}),
	})).body, {...dog, custom: 'parser'});
});

test.serial('incrementally decodes UTF-8 text response while downloading', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	let responseEnded = false;
	let streamDecodeCallCount = 0;
	let decodedBeforeResponseEnded = false;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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
		t.is(body, 'hello world');
		t.true(streamDecodeCallCount > 0);
		t.true(decodedBeforeResponseEnded);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('incrementally decodes UTF-8 JSON response while downloading', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	let responseEnded = false;
	let streamDecodeCallCount = 0;
	let decodedBeforeResponseEnded = false;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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
		}, 25);
	});

	try {
		const {body} = await got<{hello: string}>({responseType: 'json'});
		t.deepEqual(body, {hello: 'world'});
		t.true(streamDecodeCallCount > 0);
		t.true(decodedBeforeResponseEnded);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('falls back to buffered decode when incremental decode throws', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	const payload = {hello: 'world'};
	let thrown = false;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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
		t.true(thrown);
		t.deepEqual(body, payload);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('falls back to buffered decode when incremental decoder final flush throws', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	const payload = {hello: 'world'};
	let thrown = false;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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
		t.true(thrown);
		t.deepEqual(body, payload);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('does not incrementally decode for non-UTF-8 encoding', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	const payload = 'a'.repeat(1024);
	let streamDecodeCallCount = 0;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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

		t.is(body, Buffer.from(payload).toString('base64'));
		t.is(streamDecodeCallCount, 0);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('incrementally decodes for case-insensitive UTF-8 encoding names', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	const payload = 'hello world';
	const encoding = Buffer.from([85, 84, 70, 45, 56]).toString() as BufferEncoding;
	let streamDecodeCallCount = 0;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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
			t.is(response.body, payload);
		}

		t.true(streamDecodeCallCount > 0);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test.serial('does not incrementally decode in stream mode', withServer, async (t, server, got) => {
	if (globalThis.TextDecoder === undefined) {
		t.pass();
		return;
	}

	const originalDecode = globalThis.TextDecoder.prototype.decode;
	let streamDecodeCallCount = 0;

	globalThis.TextDecoder.prototype.decode = function (input?: BufferSource, options?: TextDecodeOptions): string {
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

		t.is(streamDecodeCallCount, 0);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test('JSON shortcut reads mutations made through the buffer shortcut', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{"value":1}');
	});

	const promise = got('');
	const buffer = await promise.buffer();
	buffer[9] = '2'.codePointAt(0)!;

	t.deepEqual(await promise.json(), {value: 2});
});

for (const responseType of ['text', 'json', 'buffer'] as const) {
	test(`shortcuts read repeated rawBody mutations after a ${responseType} response`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('{"value":1}');
		});

		const promise = got('', {responseType});
		const response = await promise as Response;
		const buffer = await promise.buffer();
		t.is(buffer, response.rawBody);

		for (const value of [2, 3]) {
			buffer[9] = String(value).codePointAt(0)!;
			// eslint-disable-next-line no-await-in-loop
			t.deepEqual(await promise.json(), {value});
			// eslint-disable-next-line no-await-in-loop
			t.is(await promise.text(), `{"value":${value}}`);
		}

		buffer[9] = 'x'.codePointAt(0)!;
		await t.throwsAsync(promise.json(), {instanceOf: ParseError});
	});
}

test('JSON parse failures preserve the configured response encoding', withServer, async (t, server, got) => {
	const body = 'Invalid JSON: café';
	server.get('/', (_request, response) => {
		response.end(Buffer.from(body, 'utf16le'));
	});

	const error = await t.throwsAsync<ParseError>(got('', {
		responseType: 'json',
		encoding: 'utf16le',
		retry: {limit: 0},
	}), {instanceOf: ParseError});

	t.is(error?.response.body, body);
});

for (const encoding of ['utf16le', 'latin1', 'utf8'] as const) {
	for (const throwHttpErrors of [true, false]) {
		test(`invalid JSON HTTP errors preserve ${encoding} text with throwHttpErrors=${throwHttpErrors}`, withServer, async (t, server, got) => {
			const body = 'Service indisponible: café';
			const rawBody = Buffer.from(body, encoding);
			server.get('/', (_request, response) => {
				response.statusCode = 400;
				response.end(rawBody);
			});

			const promise = got('', {responseType: 'json', encoding, throwHttpErrors});
			const response = throwHttpErrors
				? (await t.throwsAsync<HTTPError>(promise, {instanceOf: HTTPError})).response
				: await promise;

			t.is(response.body, body);
			t.deepEqual(response.rawBody, new Uint8Array(rawBody));
			t.is(response.statusCode, 400);
		});
	}
}

test('text responses strip their UTF-8 BOM when storing cookies', withServer, async (t, server, got) => {
	const body = '\uFEFFhello';
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

	t.is(response.body, 'hello');
});

for (const encoding of ['utf8', 'utf16le', 'latin1'] as const) {
	test(`cookie storage preserves ${encoding} response text and raw bytes`, withServer, async (t, server, got) => {
		const body = encoding === 'latin1' ? 'café' : '\uFEFFcafé 🦄';
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
		t.is((await promise).body, decoded);
		t.deepEqual(await promise.buffer(), new Uint8Array(bytes));
		t.is(await promise.text(), decoded);
		t.deepEqual(storedCookies, ['first=one', 'second=two']);
	});
}

test('empty text responses remain empty when storing cookies', withServer, async (t, server, got) => {
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

	t.is(body, '');
});

test('custom JSON parser failures preserve thrown string messages', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const error = await t.throwsAsync<ParseError>(got('', {
		responseType: 'json',
		parseJson() {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw 'Parser rejected this document';
		},
	}), {instanceOf: ParseError});

	t.true(error.message.startsWith('Parser rejected this document'));
});

for (const thrown of [undefined, null, 42]) {
	for (const useShortcut of [true, false]) {
		test(`custom JSON parser wraps ${String(thrown)} with shortcut=${useShortcut}`, withServer, async (t, server, got) => {
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
			const error = await t.throwsAsync<ParseError>(useShortcut ? promise.json() : promise, {instanceOf: ParseError});

			t.true(error.message.startsWith(`${String(thrown)} in `));
			t.is(error.code, 'ERR_BODY_PARSE_FAILURE');
			t.is(error.response.statusCode, 200);
			t.is(error.response.body, '{}');
		});
	}
}

for (const thrown of [new Error('Parser failed'), {name: 'ParserError', message: 'Parser failed'}]) {
	test(`custom JSON parser preserves ${thrown.name} as its cause`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('{}');
		});

		const error = await t.throwsAsync<ParseError>(got('', {
			parseJson() {
				throw thrown;
			},
		}).json(), {instanceOf: ParseError});

		t.is(error.cause, thrown);
		t.true(error.message.startsWith('Parser failed in '));
	});
}

test('text shortcuts consume only the encoding BOM', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('\uFEFF\uFEFFhello');
	});
	const request = got('');
	const bytes = await request.buffer();
	t.is(await request.text(), new TextDecoder().decode(bytes));
	t.is(await request.text().text(), '\uFEFFhello');
});

for (const encoding of ['utf8', 'utf-8'] as const) { // eslint-disable-line unicorn/text-encoding-identifier-case -- Exercise both supported UTF-8 aliases.
	test(`text shortcuts preserve content after the BOM with ${encoding}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('\uFEFF\uFEFFhello');
		});

		t.is(await got('', {encoding}).text(), '\uFEFFhello');
	});
}

for (const body of ['', '\uFEFF', 'hello\uFEFFworld']) {
	test(`text shortcuts preserve empty and embedded-BOM content ${JSON.stringify(body)}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end(body);
		});
		const expected = body === '\uFEFF' ? '' : body;

		t.is(await got('').text(), expected);
	});
}

test('UTF-16 text shortcuts strip one BOM', withServer, async (t, server, got) => {
	const body = '\uFEFF\uFEFFhello';
	server.get('/', (_request, response) => {
		response.end(Buffer.from(body, 'utf16le'));
	});

	const request = got('', {encoding: 'utf16le'});
	t.is((await request).body, '\uFEFFhello');
	t.is(await request.text(), '\uFEFFhello');
});

test('shortcuts parse the replacement response returned by an asynchronous handler', withServer, async (t, server, got) => {
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

	t.is((await promise).body, body);
	t.deepEqual(await promise.json(), {replacement: true});
	t.is(await promise.text(), body);
	t.deepEqual(await promise.buffer(), new TextEncoder().encode(body));
	t.is(await promise.json().text(), body);
	t.deepEqual(await promise.buffer().json(), {replacement: true});
});

test('shortcuts use a parse error response recovered by a handler', withServer, async (t, server, got) => {
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

	t.is(response.body, 'invalid JSON');
	t.is(await promise.text(), 'invalid JSON');
	t.deepEqual(await promise.buffer(), new TextEncoder().encode('invalid JSON'));
	const error = await t.throwsAsync<ParseError>(promise.json(), {instanceOf: ParseError});
	t.is(error.response, response);
});

test('shortcuts do not treat body-only objects as handler replacement responses', withServer, async (t, server, got) => {
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

	t.is(await promise.text(), JSON.stringify({original: true}));
	t.deepEqual(await promise.json(), {original: true});
});

test('automatically decodes stacked content encodings in reverse order', withServer, async (t, server, got) => {
	const compressed = brotliCompressSync(gzipSync(jsonResponse));
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br', 'content-type': 'application/json'});
		response.end(compressed);
	});

	const response = await got('', {responseType: 'json'});
	t.deepEqual(response.body, dog);
	t.deepEqual(response.rawBody, new TextEncoder().encode(jsonResponse));
});

for (const {encoding, compressed} of [
	{encoding: 'br, gzip', compressed: gzipSync(brotliCompressSync(jsonResponse))},
	{encoding: 'gzip, gzip', compressed: gzipSync(gzipSync(jsonResponse))},
	{encoding: 'deflate, br', compressed: brotliCompressSync(deflateSync(jsonResponse))},
	{encoding: 'GZip,\tBR', compressed: brotliCompressSync(gzipSync(jsonResponse))},
]) {
	test(`decodes stacked ${encoding} responses and validates their compressed length`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': encoding, 'content-length': compressed.length, 'x-metadata': 'preserved'});
			response.end(compressed);
		});

		const response = await got('', {responseType: 'json', strictContentLength: true});
		t.deepEqual(response.body, dog);
		t.deepEqual(response.rawBody, new TextEncoder().encode(jsonResponse));
		t.is(response.headers['content-encoding'], undefined);
		t.is(response.headers['content-length'], undefined);
		t.is(response.headers['x-metadata'], 'preserved');
		t.true(response.rawHeaders.includes(String(compressed.length)));
	});
}

test('streams stacked encoded responses with decoded bytes', withServer, async (t, server, got) => {
	const compressed = brotliCompressSync(gzipSync('café 🦄'));
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br', 'content-length': compressed.length});
		response.write(compressed.subarray(0, 5));
		response.end(compressed.subarray(5));
	});

	t.is(await getStream(got.stream('')), 'café 🦄');
});

for (const {name, compressed} of [
	{name: 'outer', compressed: Buffer.from('invalid gzip')},
	{name: 'inner', compressed: gzipSync(Buffer.from('invalid gzip'))},
]) {
	test(`stacked decoding reports a corrupt ${name} layer`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': 'gzip, gzip'});
			response.end(compressed);
		});

		const error = await t.throwsAsync<ReadError>(got('', {retry: {limit: 0}, timeout: {request: 1000}}), {instanceOf: ReadError});
		t.is(error.code, 'ERR_READING_RESPONSE_STREAM');
		t.true(error.message.includes('incorrect header check'));
	});
}

for (const encoding of ['unknown, gzip', 'gzip, unknown']) {
	test(`leaves ${encoding} completely encoded`, withServer, async (t, server, got) => {
		const compressed = gzipSync(jsonResponse);
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': encoding, 'content-length': compressed.length});
			response.end(compressed);
		});

		const response = await got('', {responseType: 'buffer'});
		t.deepEqual(response.body, new Uint8Array(compressed));
		t.is(response.headers['content-encoding'], encoding);
		t.is(response.headers['content-length'], String(compressed.length));
	});
}

test('stacked decoding returns binary bodies without text conversion', withServer, async (t, server, got) => {
	const bytes = Uint8Array.of(0, 255, 128, 13, 10);
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br'});
		response.end(brotliCompressSync(gzipSync(bytes)));
	});

	t.deepEqual(await got('').buffer(), bytes);
});

test('stacked decoding includes zstd when supported by Node.js', withServer, async (t, server, got) => {
	if (typeof zlib.zstdCompressSync !== 'function') {
		t.pass();
		return;
	}

	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, zstd'});
		response.end(zlib.zstdCompressSync(gzipSync(jsonResponse)));
	});

	t.deepEqual(await got('').json(), dog);
});

test('stacked decoding still rejects truncated compressed transfers', withServer, async (t, server, got) => {
	const compressed = brotliCompressSync(gzipSync(jsonResponse));
	server.get('/', (request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip, br', 'content-length': compressed.length + 1});
		response.end(compressed, () => {
			request.socket.end();
		});
	});

	const error = await t.throwsAsync<ReadError>(got('', {retry: {limit: 0}, timeout: {request: 1000}}), {instanceOf: ReadError});
	t.is(error.code, 'ERR_HTTP_CONTENT_LENGTH_MISMATCH');
});

for (const {method, statusCode} of [{method: 'HEAD', statusCode: 200}, {method: 'GET', statusCode: 204}, {method: 'GET', statusCode: 304}]) {
	test(`stacked encoding metadata is not decoded for ${method} ${statusCode}`, withServer, async (t, server, got) => {
		server.all('/', (_request, response) => {
			response.writeHead(statusCode, {'content-encoding': 'gzip, br'});
			response.end();
		});
		const response = await got('', {method, headers: {'if-none-match': '"version"'}});

		t.is(response.body, '');
		t.is(response.headers['content-encoding'], 'gzip, br');
	});
}

test('followed redirects ignore invalid stacked encoded bodies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/next', 'content-encoding': 'gzip, br'});
		response.end('invalid compressed body');
	});
	server.get('/next', defaultHandler);

	const response = await got('', {responseType: 'json'});
	t.deepEqual(response.body, dog);
	t.is(response.redirectUrls.length, 1);
});

for (const encoding of ['utf8', 'latin1', 'utf16le'] as const) {
	for (const useCookieJar of [false, true]) {
		test(`preserves bytes from a custom response decoded as ${encoding} with cookie jar ${useCookieJar}`, async t => {
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

			t.is(response.body, 'café');
			t.deepEqual(response.rawBody, new Uint8Array(bytes));
			t.is(response.request.downloadProgress.transferred, bytes.length);
		});
	}
}

const payload = '﻿{"hello":"世界"}';

// eslint-disable-next-line unicorn/text-encoding-identifier-case -- Verify all supported UTF-8 aliases.
for (const encoding of [undefined, 'utf8', 'utf-8', 'UTF-8'] as const) {
	for (const shortcut of [false, true]) {
		test(`JSON parser receives BOM-stripped text with and without cookies: ${encoding ?? 'default'}, shortcut=${shortcut}`, withServer, async (t, server, got) => {
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

				t.deepEqual(body, {hello: '世界'});
			}

			t.deepEqual(inputs, [payload.slice(1), payload.slice(1)]);
		});
	}
}

for (const shortcut of [false, true]) {
	for (const useCookieJar of [false, true]) {
		test(`default JSON parser accepts a BOM: cookies=${useCookieJar}, shortcut=${shortcut}`, withServer, async (t, server, got) => {
			server.get('/', (_request, response) => {
				response.setHeader('set-cookie', 'hello=world');
				response.end(payload);
			});

			const options = {cookieJar: useCookieJar ? new CookieJar() : undefined};
			const body = shortcut ? await got(options).json() : (await got({...options, responseType: 'json'})).body;
			t.deepEqual(body, {hello: '世界'});
		});
	}
}

test('empty JSON response with cookies does not call the parser', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const options = {
		cookieJar: new CookieJar(),
		parseJson() {
			t.fail('Empty bodies must not be parsed');
		},
	};

	t.is((await got({...options, responseType: 'json'})).body, '');
	t.is(await got(options).json(), '');
});

test('JSON parser receives BOM-stripped UTF-16 text with cookies', withServer, async (t, server, got) => {
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

	t.deepEqual((await got({...options, responseType: 'json'})).body, {hello: '世界'});
	t.deepEqual(await got(options).json(), {hello: '世界'});
	t.deepEqual(inputs, [payload.slice(1), payload.slice(1)]);
});
