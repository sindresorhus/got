import process from 'node:process';
import {Buffer} from 'node:buffer';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import delay from 'delay';
import {pEvent} from 'p-event';
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

test('GET cannot have body without the `allowGetBody` option', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(got.get({body: 'hi'}), {message: 'The `GET` method cannot be used with a body'});
});

test('GET can have body with option allowGetBody', withServer, async (t, server, got) => {
	server.get('/', defaultEndpoint);

	await t.notThrowsAsync(got.get({body: 'hi', allowGetBody: true}));
});

test('invalid body', async t => {
	// @ts-expect-error Error tests
	await t.throwsAsync(got.post('https://example.com', {body: {}}));
});

test('sends strings', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: 'wow'});
	t.is(body, 'wow');
});

test('sends Buffers', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: Buffer.from('wow')});
	t.is(body, 'wow');
});

test('sends Uint8Array', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const uint8Body = new Uint8Array([119, 111, 119]); // 'wow' in ASCII
	const {body} = await got.post({body: uint8Body});
	t.is(body, 'wow');
});

test('sends Uint16Array', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const text = 'hello';
	const buffer = Buffer.from(text);
	const uint16Body = new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Uint16Array.BYTES_PER_ELEMENT);
	const {body} = await got.post({body: uint16Body});
	t.is(Buffer.from(uint16Body.buffer, uint16Body.byteOffset, uint16Body.byteLength).toString(), body);
});

test('`content-length` header with Uint8Array body', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const uint8Body = new Uint8Array([119, 111, 119]);
	const {body} = await got.post({body: uint8Body});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('sends Streams', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: stream.Readable.from('wow')});
	t.is(body, 'wow');
});

test('sends plain objects as forms', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		form: {such: 'wow'},
	});

	t.is(body, 'such=wow');
});

test('QUERY sends JSON', withServer, async (t, server, got) => {
	t.plan(3);

	server.all('/', async (request, response) => {
		t.is(request.method, 'QUERY');
		t.is(request.headers['content-type'], 'application/json');
		await streamPipeline(request, response);
	});

	const payload = {
		foo: true,
	};

	const body = await got.query<typeof payload>({
		json: payload,
	}).json();

	t.deepEqual(body, payload);
});

test('does not support sending arrays as forms', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(got.post({
		form: ['such', 'wow'],
	}));
});

test('sends plain objects as JSON', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		json: {such: 'wow'},
		responseType: 'json',
	});
	t.deepEqual(body, {such: 'wow'});
});

test('sends arrays as JSON', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		json: ['such', 'wow'],
		responseType: 'json',
	});
	t.deepEqual(body, ['such', 'wow']);
});

test('works with empty post response', withServer, async (t, server, got) => {
	server.post('/empty', (_request, response) => {
		response.end();
	});

	const {body} = await got.post('empty', {body: 'wow'});
	t.is(body, '');
});

test('`content-length` header with string body', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({body: 'wow'});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('`content-length` header with json body', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({json: {foo: 'bar'}});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '13');
});

test('`content-length` header with form body', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({form: {foo: 'bar'}});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '7');
});

test('`content-length` header with Buffer body', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({body: Buffer.from('wow')});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('`content-length` header with Stream body', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({body: stream.Readable.from('wow')});
	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	t.is(headers['content-length'], undefined);
});

test('`content-length` header is not overriden', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		body: 'wow',
		headers: {
			'content-length': '10',
		},
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '10');
});

test('`content-length` header is present when using custom content-type', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		json: {foo: 'bar'},
		headers: {
			'content-type': 'custom',
		},
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '13');
});

test('`content-length` header disabled for chunked transfer-encoding', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		body: '3\r\nwow\r\n0\r\n',
		headers: {
			'transfer-encoding': 'chunked',
		},
	});
	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	t.is(headers['content-length'], undefined);
});

test('`content-type` header is not overriden when object in `options.body`', withServer, async (t, server, got) => {
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
	t.is(headers['content-type'], 'doge');
});

test('throws when form body is not a plain object or array', async t => {
	// @ts-expect-error Manual test
	await t.throwsAsync(got.post('https://example.com', {form: 'such=wow'}));
});

// See https://github.com/sindresorhus/got/issues/897
test('the `json` payload is not touched', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post<{context: {foo: true}}>({
		json: {
			context: {
				foo: true,
			},
		},
		responseType: 'json',
	});

	t.true('context' in body);
	t.true(body.context.foo);
});

test('the `body` payload is not touched', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const buffer = Buffer.from('Hello, Got!') as Uint8Array & {context?: unknown};
	buffer.context = {foo: 'bar'};

	const body = await got.post({body: buffer}).text();
	t.is(body, 'Hello, Got!');
});

test('the `form` payload is not touched', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const form = {
		context: true,
	};

	const body = await got.post({form}).text();
	t.is(body, 'context=true');
});

test('DELETE method sends plain objects as JSON', withServer, async (t, server, got) => {
	server.delete('/', defaultEndpoint);

	const {body} = await got.delete({
		json: {such: 'wow'},
		responseType: 'json',
	});
	t.deepEqual(body, {such: 'wow'});
});

test('catches body errors before calling pipeline() - promise', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(got.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt'),
	}), {
		message: /ENOENT: no such file or directory/v,
	});

	// Wait for unhandled errors
	await delay(100);
});

test('catches body errors before calling pipeline() - stream', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(getStream(got.stream.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt'),
	})), {
		message: /ENOENT: no such file or directory/v,
	});

	// Wait for unhandled errors
	await delay(100);
});

test('body - file read stream', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const fullPath = path.resolve('test/fixtures/ok');
	const toSend = await getStream(fs.createReadStream(fullPath));

	const body = await got.post({
		body: fs.createReadStream(fullPath),
	}).text();

	t.is(toSend, body);
});

test('body - file read stream, wait for `ready` event', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const fullPath = path.resolve('test/fixtures/ok');
	const toSend = await getStream(fs.createReadStream(fullPath));
	const ifStream = fs.createReadStream(fullPath);

	await pEvent(ifStream, 'ready');

	const body = await got.post({
		body: ifStream,
	}).text();

	t.is(toSend, body);
});

test('body - sends native FormData', withServer, async (t, server, got) => {
	server.post('/', echoMultipartBody);

	const form = new globalThis.FormData();
	form.set('a', 'b');
	const body = await got.post({body: form}).json<{a: string}>();
	t.is(body.a, 'b');
});

test('body - sends files with native FormData', withServer, async (t, server, got) => {
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

	const form = new globalThis.FormData();
	form.set('blob', new Blob([blobContent]));
	form.set('file', new File([fileContent], 'file.txt', {type: 'text/plain'}));
	form.set('anotherFile', new File([anotherFileContent], 'ok', {type: 'text/plain'}));
	const body = await got.post({body: form}).json<typeof expected>();
	t.deepEqual(body, expected);
});

test('body - throws on non-native FormData', withServer, async (t, server, got) => {
	server.post('/', echoMultipartBody);

	const form = new NodeFetchFormData();
	form.set('a', 'b');

	await t.throwsAsync(got.post({body: form}), {
		code: 'ERR_GOT_REQUEST_ERROR',
		message: 'Non-native FormData is not supported. Use globalThis.FormData instead.',
	});
});

test('throws on upload error', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const body = new stream.PassThrough();
	const message = 'oh no';

	await t.throwsAsync(getStream(got.stream.post({
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
	})), {
		instanceOf: UploadError,
		message,
		code: 'ERR_UPLOAD',
	});
});

test('formdata retry', withServer, async (t, server, got) => {
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

	const form = new globalThis.FormData();
	form.set('hello', 'world');

	// The retried request must resend the complete form with a matching boundary.
	const body = await instance.post({body: form}).json<Record<string, string>>();

	t.deepEqual(body, {hello: 'world'});
});

test('upload error preserves `UploadError` code when underlying error has a code', async t => {
	const body = new stream.PassThrough();
	const error = new Error('oh no') as NodeJS.ErrnoException;
	error.code = 'EPIPE';

	await t.throwsAsync(getStream(got.stream.post('https://example.com', {
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
	})), {
		instanceOf: UploadError,
		message: 'oh no',
		code: 'ERR_UPLOAD',
	});
});

test('body - sends async iterable', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	async function * generateData() {
		yield 'Hello, ';
		yield 'world!';
	}

	const body = await got.post({
		body: generateData(),
	}).text();

	t.is(body, 'Hello, world!');
});

test('body - sends iterable', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	function * generateData() {
		yield 'foo';
		yield 'bar';
	}

	const body = await got.post({
		body: generateData(),
	}).text();

	t.is(body, 'foobar');
});

test('async iterable source errors do not become network retries', withServer, async (t, server, got) => {
	server.put('/', request => {
		request.resume();
	});
	const cause = Object.assign(new Error('Iterable source failed'), {code: 'ECONNRESET'});
	let retries = 0;
	async function * body() {
		yield 'first chunk';
		throw cause;
	}

	const error = await t.throwsAsync<UploadError>(got.put('', {
		body: body(),
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [() => {
				retries++;
			}],
		},
	}), {instanceOf: UploadError, code: 'ERR_UPLOAD', message: cause.message});

	t.is(error.cause, cause);
	t.is(retries, 0);
});

for (const asynchronous of [false, true]) {
	for (const yieldFirst of [false, true]) {
		test(`iterable upload errors preserve their cause with async ${asynchronous} and first chunk ${yieldFirst}`, withServer, async (t, server, got) => {
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
			const error = await t.throwsAsync<UploadError>(getStream(got.stream.post('', {body})), {
				instanceOf: UploadError,
				code: 'ERR_UPLOAD',
				message: cause.message,
			});

			t.is(error.cause, cause);
		});
	}
}

test('iterator acquisition failures are upload errors', withServer, async (t, _server, got) => {
	const cause = new Error('Could not open source');
	const body = {
		[Symbol.asyncIterator](): AsyncIterator<string> {
			throw cause;
		},
	};
	const error = await t.throwsAsync<UploadError>(got.post('', {body}), {
		instanceOf: UploadError,
		code: 'ERR_UPLOAD',
		message: cause.message,
	});

	t.is(error.cause, cause);
});

for (const chunks of [[], ['hello ', new Uint8Array(Buffer.from('world'))]]) {
	test(`iterable uploads support ${chunks.length} chunks`, withServer, async (t, server, got) => {
		server.post('/', defaultEndpoint);

		t.is(await got.post('', {body: chunks}).text(), chunks.length === 0 ? '' : 'hello world');
	});
}

test('network failures during iterable uploads remain request errors', withServer, async (t, server, got) => {
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

	const error = await t.throwsAsync<RequestError>(got.put('', {body: body(), retry: {limit: 0}}), {instanceOf: RequestError});

	t.false(error instanceof UploadError);
	t.true(['ECONNRESET', 'EPIPE'].includes(error.code));
	await finished.promise;
});

test('JSON serialization preserves an array-valued Content-Type', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({contentType: request.headers['content-type'], body: await getStream(request)});
	});

	const result = await got.post('', {
		json: {message: 'hello'},
		headers: {'Content-Type': ['application/vnd.api+json']},
	}).json<{contentType: string; body: string}>();

	t.is(result.body, '{"message":"hello"}');
	t.is(result.contentType, 'application/vnd.api+json');
});

test('form serialization preserves an array-valued Content-Type inherited from defaults', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({contentType: request.headers['content-type'], body: await getStream(request)});
	});
	const contentType = ['application/x-www-form-urlencoded; charset=UTF-8'];
	const client = got.extend({headers: {'content-type': contentType}});
	const result = await client.post('', {form: {message: 'hello world', count: 2}}).json<{contentType: string; body: string}>();

	t.is(result.contentType, 'application/x-www-form-urlencoded; charset=UTF-8');
	t.is(result.body, 'message=hello+world&count=2');
	t.deepEqual(contentType, ['application/x-www-form-urlencoded; charset=UTF-8']);
});

test('FormData serialization preserves an explicit array-valued media type', withServer, async (t, server, got) => {
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

	t.is(result.contentType, 'application/octet-stream');
	t.true(result.body.includes('name="message"\r\n\r\nhello\r\n'));
	t.true(result.body.startsWith('--'));
});

for (const contentType of ['application/problem+json', undefined]) {
	test(`JSON serialization handles ${contentType ?? 'undefined'} Content-Type`, withServer, async (t, server, got) => {
		server.post('/', async (request, response) => {
			response.json({contentType: request.headers['content-type'], body: await getStream(request)});
		});
		const result = await got.post('', {
			json: {message: 'hello'},
			headers: {'content-type': contentType},
		}).json<{contentType: string; body: string}>();

		t.is(result.contentType, contentType ?? 'application/json');
		t.is(result.body, '{"message":"hello"}');
	});
}
