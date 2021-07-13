import {promisify} from 'util';
import stream from 'stream';
import fs from 'fs';
import path from 'path';
import test from 'ava';
import delay from 'delay';
import pEvent from 'p-event';
import {Handler} from 'express';
import getStream from 'get-stream';
import FormData from 'form-data';
import toReadableStream from 'to-readable-stream';
import got, {UploadError} from '../source/index.js';
import withServer from './helpers/with-server.js';

const pStreamPipeline = promisify(stream.pipeline);

const defaultEndpoint: Handler = async (request, response) => {
	response.setHeader('method', request.method);
	await pStreamPipeline(request, response);
};

const echoHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
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
	await t.throwsAsync(
		// @ts-expect-error Error tests
		got.post('https://example.com', {body: {}}),
	);
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

test('sends Streams', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({body: toReadableStream('wow')});
	t.is(body, 'wow');
});

test('sends plain objects as forms', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		form: {such: 'wow'},
	});

	t.is(body, 'such=wow');
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

	const {body} = await got.post({body: toReadableStream('wow')});
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

	const buffer = Buffer.from('Hello, Got!');
	// @ts-expect-error
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
		message: /ENOENT: no such file or directory/,
	});

	// Wait for unhandled errors
	await delay(100);
});

test('catches body errors before calling pipeline() - stream', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(getStream(got.stream.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt'),
	})), {
		message: /ENOENT: no such file or directory/,
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
	server.post('/', echoHeaders);

	const instance = got.extend({
		hooks: {
			afterResponse: [
				async (_response, retryWithMergedOptions) => retryWithMergedOptions({
					headers: {
						foo: 'bar',
					},
				}),
			],
		},
	});

	const form = new FormData();
	form.append('hello', 'world');

	await t.throwsAsync(instance.post({
		body: form,
		headers: form.getHeaders(),
	}).json<{foo?: string}>(), {
		message: 'Cannot retry with consumed body stream',
	});
});
