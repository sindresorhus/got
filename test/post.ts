import process from 'node:process';
import {Buffer} from 'node:buffer';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import delay from 'delay';
import type {Handler} from 'express';
import {
	parse,
	Body,
	isBodyFile,
	type BodyEntryPath,
	type BodyEntryRawValue,
} from 'then-busboy';
import getStream from 'get-stream';
import {FormData as NodeFetchFormData} from 'node-fetch';
import got, {RequestError, UploadError} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const defaultEndpoint: Handler = async (request, response) => {
	response.setHeader('method', request.method);
	await streamPipeline(request, response);
};

const echoHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

const echoMultipartBody: Handler = async (request, response) => {
	const body = await parse(request);
	const entries = await Promise.all([...body.entries()].map<Promise<[BodyEntryPath, BodyEntryRawValue]>>(async ([name, value]) => [name, isBodyFile(value) ? await value.text() : value]));

	response.json(Body.json(entries));
};

test('GET cannot have body without the `allowGetBody` option', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	await assert.rejects(got.get({body: 'hi'}), {message: 'The `GET` method cannot be used with a body'});
});

test('GET can have body with option allowGetBody', withServer, async (_t, server, got) => {
	server.get('/', defaultEndpoint);

	await assert.doesNotReject(got.get({body: 'hi', allowGetBody: true}));
});

test('invalid body', async _t => {
	// @ts-expect-error Error tests
	await assert.rejects(got.post('https://example.com', {body: {}}));
});

test('sends strings', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: 'wow'});
	assert.strictEqual(body, 'wow');
});

test('sends Buffers', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: Buffer.from('wow')});
	assert.strictEqual(body, 'wow');
});

test('sends Uint8Array', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const uint8Body = new Uint8Array([119, 111, 119]); // 'wow' in ASCII
	const {body} = await got.post({body: uint8Body});
	assert.strictEqual(body, 'wow');
});

test('sends Uint16Array', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const text = 'hello';
	const buffer = Buffer.from(text);
	const uint16Body = new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Uint16Array.BYTES_PER_ELEMENT);
	const {body} = await got.post({body: uint16Body});
	assert.strictEqual(Buffer.from(uint16Body.buffer, uint16Body.byteOffset, uint16Body.byteLength).toString(), body);
});

test('`content-length` header with Uint8Array body', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const uint8Body = new Uint8Array([119, 111, 119]);
	const {body} = await got.post({body: uint8Body});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '3');
});

test('sends Streams', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: stream.Readable.from('wow')});
	assert.strictEqual(body, 'wow');
});

test('sends plain objects as forms', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		form: {such: 'wow'},
	});

	assert.strictEqual(body, 'such=wow');
});

test('QUERY sends JSON', withServer, async (_t, server, got) => {
	let requestCount = 0;

	server.all('/', async (request, response) => {
		requestCount += 1;
		assert.strictEqual(request.method, 'QUERY');
		assert.strictEqual(request.headers['content-type'], 'application/json');
		await streamPipeline(request, response);
	});

	const payload = {
		foo: true,
	};

	const body = await got.query<typeof payload>({
		json: payload,
	}).json();

	assert.deepStrictEqual(body, payload);
	assert.strictEqual(requestCount, 1);
});

test('does not support sending arrays as forms', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	await assert.rejects(got.post({
		form: ['such', 'wow'],
	}));
});

test('sends plain objects as JSON', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		json: {such: 'wow'},
		responseType: 'json',
	});
	assert.deepStrictEqual(body, {such: 'wow'});
});

test('sends arrays as JSON', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		json: ['such', 'wow'],
		responseType: 'json',
	});
	assert.deepStrictEqual(body, ['such', 'wow']);
});

test('works with empty post response', withServer, async (_t, server, got) => {
	server.post('/empty', (_request, response) => {
		response.end();
	});

	const {body} = await got.post('empty', {body: 'wow'});
	assert.strictEqual(body, '');
});

test('`content-length` header with string body', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({body: 'wow'});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '3');
});

test('`content-length` header with json body', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({json: {foo: 'bar'}});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '13');
});

test('`content-length` header with form body', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({form: {foo: 'bar'}});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '7');
});

test('`content-length` header with Buffer body', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({body: Buffer.from('wow')});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '3');
});

test('`content-length` header with Stream body', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({body: stream.Readable.from('wow')});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	assert.strictEqual(headers['content-length'], undefined);
});

test('`content-length` header is not overriden', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		body: 'wow',
		headers: {
			'content-length': '10',
		},
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '10');
});

test('`content-length` header is present when using custom content-type', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		json: {foo: 'bar'},
		headers: {
			'content-type': 'custom',
		},
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '13');
});

test('`content-length` header disabled for chunked transfer-encoding', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		body: '3\r\nwow\r\n0\r\n',
		headers: {
			'transfer-encoding': 'chunked',
		},
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	assert.strictEqual(headers['content-length'], undefined);
});

test('`content-type` header is not overriden when object in `options.body`', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body: headers} = await got.post<Record<string, string>>({
		headers: {
			'content-type': 'doge',
		},
		json: {
			such: 'wow',
		},
		responseType: 'json',
	});
	assert.strictEqual(headers['content-type'], 'doge');
});

test('throws when form body is not a plain object or array', async _t => {
	// @ts-expect-error Manual test
	await assert.rejects(got.post('https://example.com', {form: 'such=wow'}));
});

// See https://github.com/sindresorhus/got/issues/897
test('the `json` payload is not touched', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post<{context: {foo: true}}>({
		json: {
			context: {
				foo: true,
			},
		},
		responseType: 'json',
	});

	assert.strictEqual('context' in body, true);
	assert.strictEqual(body.context.foo, true);
});

test('the `body` payload is not touched', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const buffer = Buffer.from('Hello, Got!') as Uint8Array & {context?: unknown};
	buffer.context = {foo: 'bar'};

	const body = await got.post({body: buffer}).text();
	assert.strictEqual(body, 'Hello, Got!');
});

test('the `form` payload is not touched', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const form = {
		context: true,
	};

	const body = await got.post({form}).text();
	assert.strictEqual(body, 'context=true');
});

test('DELETE method sends plain objects as JSON', withServer, async (_t, server, got) => {
	server.delete('/', defaultEndpoint);

	const {body} = await got.delete({
		json: {such: 'wow'},
		responseType: 'json',
	});
	assert.deepStrictEqual(body, {such: 'wow'});
});

test('catches body errors before calling pipeline() - promise', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	await assert.rejects(got.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt'),
	}), {
		message: /ENOENT: no such file or directory/v,
	});

	// Wait for unhandled errors
	await delay(100);
});

test('catches body errors before calling pipeline() - stream', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	await assert.rejects(getStream(got.stream.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt'),
	})), {
		message: /ENOENT: no such file or directory/v,
	});

	// Wait for unhandled errors
	await delay(100);
});

test('body - file read stream', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const fullPath = path.resolve('test/fixtures/ok');
	const toSend = await getStream(fs.createReadStream(fullPath));

	const body = await got.post({
		body: fs.createReadStream(fullPath),
	}).text();

	assert.strictEqual(toSend, body);
});

test('body - file read stream, wait for `ready` event', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const fullPath = path.resolve('test/fixtures/ok');
	const toSend = await getStream(fs.createReadStream(fullPath));
	const ifStream = fs.createReadStream(fullPath);

	await once(ifStream, 'ready');

	const body = await got.post({
		body: ifStream,
	}).text();

	assert.strictEqual(toSend, body);
});

test('body - sends native FormData', withServer, async (_t, server, got) => {
	server.post('/', echoMultipartBody);

	const form = new FormData();
	form.set('a', 'b');
	const body = await got.post({body: form}).json<{a: string}>();
	assert.strictEqual(body.a, 'b');
});

test('body - sends files with native FormData', withServer, async (_t, server, got) => {
	server.post('/', echoMultipartBody);

	const fullPath = path.resolve('test/fixtures/ok');
	const blobContent = 'Blob content';
	const fileContent = 'File content';
	const anotherFileContent = await fsPromises.readFile(fullPath, 'utf8');
	const expected = {
		blob: blobContent,
		file: fileContent,
		anotherFile: anotherFileContent,
	};

	const form = new FormData();
	form.set('blob', new Blob([blobContent]));
	form.set('file', new File([fileContent], 'file.txt', {type: 'text/plain'}));
	form.set('anotherFile', new File([anotherFileContent], 'ok', {type: 'text/plain'}));
	const body = await got.post({body: form}).json<typeof expected>();
	assert.deepStrictEqual(body, expected);
});

test('body - throws on non-native FormData', withServer, async (_t, server, got) => {
	server.post('/', echoMultipartBody);

	const form = new NodeFetchFormData();
	form.set('a', 'b');

	await assert.rejects(got.post({body: form}), {
		code: 'ERR_GOT_REQUEST_ERROR',
		message: 'Non-native FormData is not supported. Use globalThis.FormData instead.',
	});
});

test('throws on upload error', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	const body = new stream.PassThrough();
	const message = 'oh no';

	await assert.rejects(getStream(got.stream.post({
		body,
		hooks: {
			beforeRequest: [
				() => {
					process.nextTick(() => {
						body.destroy(new Error(message));
					});
				},
			],
		},
	})), errorMatching(UploadError, {message, code: 'ERR_UPLOAD'}));
});

test('formdata retry', withServer, async (_t, server, got) => {
	server.post('/', echoMultipartBody);

	const instance = got.extend({
		hooks: {
			afterResponse: [
				async (response, retryWithMergedOptions) => {
					if (response.request.options.headers.foo === undefined) {
						return retryWithMergedOptions({
							headers: {
								foo: 'bar',
							},
						});
					}

					return response;
				},
			],
		},
	});

	const form = new FormData();
	form.set('hello', 'world');

	// The retried request must resend the complete form with a matching boundary.
	const body = await instance.post({body: form}).json<Record<string, string>>();

	assert.deepStrictEqual(body, {hello: 'world'});
});

test('upload error preserves `UploadError` code when underlying error has a code', async _t => {
	const body = new stream.PassThrough();
	const error = new Error('oh no') as NodeJS.ErrnoException;
	error.code = 'EPIPE';

	await assert.rejects(getStream(got.stream.post('https://example.com', {
		body,
		hooks: {
			beforeRequest: [
				() => {
					process.nextTick(() => {
						body.destroy(error);
					});
				},
			],
		},
	})), errorMatching(UploadError, {message: 'oh no', code: 'ERR_UPLOAD'}));
});

test('body - sends async iterable', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	async function * generateData() {
		yield 'Hello, ';
		yield 'world!';
	}

	const body = await got.post({
		body: generateData(),
	}).text();

	assert.strictEqual(body, 'Hello, world!');
});

test('body - sends iterable', withServer, async (_t, server, got) => {
	server.post('/', defaultEndpoint);

	function * generateData() {
		yield 'foo';
		yield 'bar';
	}

	const body = await got.post({
		body: generateData(),
	}).text();

	assert.strictEqual(body, 'foobar');
});

test('async iterable source errors do not become network retries', withServer, async (_t, server, got) => {
	server.put('/', request => {
		request.resume();
	});
	const cause = Object.assign(new Error('Iterable source failed'), {code: 'ECONNRESET'});
	let retries = 0;
	async function * body() {
		yield 'first chunk';
		throw cause;
	}

	const error = await rejects(got.put('', {
		body: body(),
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [() => {
				retries++;
			}],
		},
	}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(retries, 0);
});

for (const asynchronous of [false, true]) {
	for (const yieldFirst of [false, true]) {
		test(`iterable upload errors preserve their cause with async ${asynchronous} and first chunk ${yieldFirst}`, withServer, async (_t, server, got) => {
			server.post('/', request => {
				request.resume();
			});
			const cause = Object.assign(new Error('Source failed'), {code: 'EPIPE'});
			function * generate() {
				if (yieldFirst) {
					yield 'first chunk';
				}

				throw cause;
			}

			async function * generateAsync() {
				yield * generate();
			}

			const body = asynchronous ? generateAsync() : generate();
			const error = await rejects(getStream(got.stream.post('', {body})), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

			assert.strictEqual(error.cause, cause);
		});
	}
}

test('iterator acquisition failures are upload errors', withServer, async (_t, _server, got) => {
	const cause = new Error('Could not open source');
	const body = {
		[Symbol.asyncIterator](): AsyncIterator<string> {
			throw cause;
		},
	};
	const error = await rejects(got.post('', {body}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
});

for (const chunks of [[], ['hello ', new Uint8Array(Buffer.from('world'))]]) {
	test(`iterable uploads support ${chunks.length} chunks`, withServer, async (_t, server, got) => {
		server.post('/', defaultEndpoint);

		assert.strictEqual(await got.post('', {body: chunks}).text(), chunks.length === 0 ? '' : 'hello world');
	});
}

test('network failures during iterable uploads remain request errors', withServer, async (_t, server, got) => {
	server.put('/', request => {
		request.once('data', () => {
			request.socket.destroy();
		});
	});
	const finished = Promise.withResolvers<void>();
	async function * body() {
		try {
			while (true) {
				yield 'chunk';
				// eslint-disable-next-line no-await-in-loop
				await delay(1);
			}
		} finally {
			finished.resolve();
		}
	}

	const error = await rejects(got.put('', {body: body(), retry: {limit: 0}}), RequestError);

	// A socket write failure is a request error, not a failure of the body source. Which code
	// surfaces depends on whether the write or the read side notices the reset first, but it is
	// always one of the socket's own codes rather than Got's generic one.
	assert.strictEqual(error instanceof UploadError, false);
	assert.strictEqual(['ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code ?? ''), true, `Unexpected code ${error.code}`);
	await finished.promise;
});

test('JSON serialization preserves an array-valued Content-Type', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({contentType: request.headers['content-type'], body: await getStream(request)});
	});

	const result = await got.post('', {
		json: {message: 'hello'},
		headers: {'Content-Type': ['application/vnd.api+json']},
	}).json<{contentType: string; body: string}>();

	assert.strictEqual(result.body, '{"message":"hello"}');
	assert.strictEqual(result.contentType, 'application/vnd.api+json');
});

test('form serialization preserves an array-valued Content-Type inherited from defaults', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({contentType: request.headers['content-type'], body: await getStream(request)});
	});
	const contentType = ['application/x-www-form-urlencoded; charset=UTF-8'];
	const client = got.extend({headers: {'content-type': contentType}});
	const result = await client.post('', {form: {message: 'hello world', count: 2}}).json<{contentType: string; body: string}>();

	assert.strictEqual(result.contentType, 'application/x-www-form-urlencoded; charset=UTF-8');
	assert.strictEqual(result.body, 'message=hello+world&count=2');
	assert.deepStrictEqual(contentType, ['application/x-www-form-urlencoded; charset=UTF-8']);
});

test('FormData serialization preserves an explicit array-valued media type', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({contentType: request.headers['content-type'], body: await getStream(request)});
	});
	const form = new FormData();
	form.set('message', 'hello');
	// Sending the serialized multipart bytes as opaque data does not require a boundary parameter.
	const result = await got.post('', {
		body: form,
		headers: {'content-type': ['application/octet-stream']},
	}).json<{contentType: string; body: string}>();

	assert.strictEqual(result.contentType, 'application/octet-stream');
	assert.strictEqual(result.body.includes('name="message"\r\n\r\nhello\r\n'), true);
	assert.strictEqual(result.body.startsWith('--'), true);
});

for (const contentType of ['application/problem+json', undefined]) {
	test(`JSON serialization handles ${contentType ?? 'undefined'} Content-Type`, withServer, async (_t, server, got) => {
		server.post('/', async (request, response) => {
			response.json({contentType: request.headers['content-type'], body: await getStream(request)});
		});
		const result = await got.post('', {
			json: {message: 'hello'},
			headers: {'content-type': contentType},
		}).json<{contentType: string; body: string}>();

		assert.strictEqual(result.contentType, contentType ?? 'application/json');
		assert.strictEqual(result.body, '{"message":"hello"}');
	});
}

const echoRequest: Handler = async (request, response) => {
	const body = Buffer.concat(await request.toArray()).toString();
	response.json({headers: request.headers, body});
};

type EchoedRequest = {headers: Record<string, string | undefined>; body: string};

test('`content-length` header counts UTF-8 bytes of a multibyte string body', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const body = 'café 🦄';
	const result = await got.post({body}).json<EchoedRequest>();

	assert.notStrictEqual(Buffer.byteLength(body), body.length);
	assert.strictEqual(result.headers['content-length'], String(Buffer.byteLength(body)));
	assert.strictEqual(result.body, body);
});

test('`content-length` header counts UTF-8 bytes of a multibyte json body', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const json = {name: 'Ünïcødé ✓'};
	const result = await got.post({json}).json<EchoedRequest>();

	assert.strictEqual(result.headers['content-length'], String(Buffer.byteLength(JSON.stringify(json))));
	assert.deepStrictEqual(JSON.parse(result.body), json);
});

test('`content-length` header is derived from the custom `stringifyJson` output', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const stringified = '{"replaced":"ü✓"}';
	const result = await got.post({
		json: {original: true},
		stringifyJson: () => stringified,
	}).json<EchoedRequest>();

	assert.strictEqual(result.body, stringified);
	assert.strictEqual(result.headers['content-length'], String(Buffer.byteLength(stringified)));
	assert.strictEqual(result.headers['content-type'], 'application/json');
});

for (const json of [null, false, 0, '']) {
	test(`sends the falsy json value ${JSON.stringify(json)} as JSON`, withServer, async (_t, server, got) => {
		server.post('/', echoRequest);

		const result = await got.post({json}).json<EchoedRequest>();

		assert.strictEqual(result.body, JSON.stringify(json));
		assert.strictEqual(result.headers['content-type'], 'application/json');
		assert.strictEqual(result.headers['content-length'], String(JSON.stringify(json).length));
	});
}

test('form values with reserved and non-ASCII characters are URL-encoded', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const form = {'a b': 'x&y=z', name: 'café', plus: '1+1'};
	const result = await got.post({form}).json<EchoedRequest>();

	assert.strictEqual(result.body, 'a+b=x%26y%3Dz&name=caf%C3%A9&plus=1%2B1');
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(result.body)), form);
	assert.strictEqual(result.headers['content-length'], String(result.body.length));
});

test('an empty form sends an empty urlencoded body', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const result = await got.post({form: {}}).json<EchoedRequest>();

	assert.strictEqual(result.body, '');
	assert.strictEqual(result.headers['content-length'], '0');
	assert.strictEqual(result.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('an empty string body sends `content-length: 0` instead of chunked encoding', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const result = await got.post({body: ''}).json<EchoedRequest>();

	assert.strictEqual(result.body, '');
	assert.strictEqual(result.headers['content-length'], '0');
	assert.strictEqual(result.headers['transfer-encoding'], undefined);
});

for (const {name, createBody} of [
	{name: 'an array', createBody: () => ['foo', 'bar']},
	{name: 'a Set', createBody: () => new Set(['foo', 'bar'])},
	{name: 'a Web ReadableStream', createBody: () => new Blob(['foo', 'bar']).stream()},
	{
		name: 'an async generator',
		async * createBody() {
			yield 'foo';
			yield 'bar';
		},
	},
]) {
	test(`${name} body is sent with chunked encoding and no \`content-length\``, withServer, async (_t, server, got) => {
		server.post('/', echoRequest);

		const result = await got.post({body: createBody() as any}).json<EchoedRequest>();

		assert.strictEqual(result.body, 'foobar');
		assert.strictEqual(result.headers['content-length'], undefined);
		assert.strictEqual(result.headers['transfer-encoding'], 'chunked');
	});
}

test('an iterable body with an explicit `content-length` is not sent chunked', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	function * generateData() {
		yield 'foo';
		yield 'bar';
	}

	const result = await got.post({
		body: generateData(),
		headers: {'content-length': '6'},
	}).json<EchoedRequest>();

	assert.strictEqual(result.body, 'foobar');
	assert.strictEqual(result.headers['content-length'], '6');
	assert.strictEqual(result.headers['transfer-encoding'], undefined);
});

test('a typed array view body sends only the viewed bytes', withServer, async (_t, server, got) => {
	server.post('/', echoRequest);

	const bytes = new TextEncoder().encode('xxpayloadyy');
	const result = await got.post({body: bytes.subarray(2, 9)}).json<EchoedRequest>();

	assert.strictEqual(result.body, 'payload');
	assert.strictEqual(result.headers['content-length'], '7');
});
