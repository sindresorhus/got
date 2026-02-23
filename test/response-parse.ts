import {Buffer} from 'node:buffer';
import test from 'ava';
import type {Handler} from 'express';
import getStream from 'get-stream';
import {HTTPError, ParseError} from '../source/index.js';
import withServer from './helpers/with-server.js';

const dog = {data: 'dog'};
const jsonResponse = JSON.stringify(dog);

const defaultHandler: Handler = (_request, response) => {
	response.end(jsonResponse);
};

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

test('Buffer response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual((await got({responseType: 'buffer'})).body, Buffer.from(jsonResponse));
});

test('Text response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is((await got({responseType: 'text'})).body, jsonResponse);
});

test('Text response #2', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is((await got({responseType: undefined})).body, jsonResponse);
});

test('Text response preserves UTF-8 BOM', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('hello')]));
	});

	t.is((await got({responseType: 'text'})).body, '\uFEFFhello');
});

test('JSON response - promise.json()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got('').json(), dog);
});

test('Buffer response - promise.buffer()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got('').buffer(), Buffer.from(jsonResponse));
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

test('JSON response with UTF-8 BOM throws ParseError', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from(jsonResponse)]));
	});

	await t.throwsAsync(got({responseType: 'json'}), {instanceOf: ParseError});
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
		message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/,
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
		message: /^Unexpected token/,
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
	t.is(buffer.compare(Buffer.from(proper)), 0);
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
