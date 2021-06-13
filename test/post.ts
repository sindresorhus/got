import {promisify} from 'util';
import stream = require('stream');
import fs = require('fs');
import path = require('path');
import test from 'ava';
import delay = require('delay');
import pEvent = require('p-event');
import {Handler} from 'express';
import getStream = require('get-stream');
import toReadableStream = require('to-readable-stream');
import got, {UploadError} from '../source';
import withServer from './helpers/with-server';

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
		{
			message: 'The `body` option must be a stream.Readable, string or Buffer'
		}
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
		form: {such: 'wow'}
	});

	t.is(body, 'such=wow');
});

test('does NOT support sending arrays as forms', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(got.post({
		form: ['such', 'wow']
	}), {
		message: 'Each query pair must be an iterable [name, value] tuple'
	});
});

test('sends plain objects as JSON', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		json: {such: 'wow'},
		responseType: 'json'
	});
	t.deepEqual(body, {such: 'wow'});
});

test('sends arrays as JSON', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post({
		json: ['such', 'wow'],
		responseType: 'json'
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
			'content-length': '10'
		}
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '10');
});

test('`content-length` header is present when using custom content-type', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		json: {foo: 'bar'},
		headers: {
			'content-type': 'custom'
		}
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '13');
});

test('`content-length` header disabled for chunked transfer-encoding', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		body: '3\r\nwow\r\n0\r\n',
		headers: {
			'transfer-encoding': 'chunked'
		}
	});
	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	t.is(headers['content-length'], undefined);
});

test('`content-type` header is not overriden when object in `options.body`', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body: headers} = await got.post<Record<string, string>>({
		headers: {
			'content-type': 'doge'
		},
		json: {
			such: 'wow'
		},
		responseType: 'json'
	});
	t.is(headers['content-type'], 'doge');
});

test('throws when form body is not a plain object or array', async t => {
	// @ts-expect-error Manual test
	await t.throwsAsync(got.post('https://example.com', {form: 'such=wow'}), {
		message: 'The `form` option must be an Object'
	});
});

// See https://github.com/sindresorhus/got/issues/897
test('the `json` payload is not touched', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const {body} = await got.post<{context: {foo: true}}>({
		json: {
			context: {
				foo: true
			}
		},
		responseType: 'json'
	});

	t.true('context' in body);
	t.true(body.context.foo);
});

test('the `body` payload is not touched', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const buffer = Buffer.from('Hello, Got!');

	await got.post({
		body: buffer,
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.body, buffer);
				}
			]
		}
	});
});

test('the `form` payload is not touched', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const object = {
		foo: 'bar'
	};

	await got.post({
		form: object,
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.form, object);
				}
			]
		}
	});
});

test('DELETE method sends plain objects as JSON', withServer, async (t, server, got) => {
	server.delete('/', defaultEndpoint);

	const {body} = await got.delete({
		json: {such: 'wow'},
		responseType: 'json'
	});
	t.deepEqual(body, {such: 'wow'});
});

test('catches body errors before calling pipeline() - promise', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(got.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt')
	}), {
		message: /ENOENT: no such file or directory/
	});

	// Wait for unhandled errors
	await delay(100);
});

test('catches body errors before calling pipeline() - stream', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	await t.throwsAsync(getStream(got.stream.post({
		body: fs.createReadStream('./file-that-does-not-exist.txt')
	})), {
		message: /ENOENT: no such file or directory/
	});

	// Wait for unhandled errors
	await delay(100);
});

test('body - file read stream', withServer, async (t, server, got) => {
	server.post('/', defaultEndpoint);

	const fullPath = path.resolve('test/fixtures/ok');
	const toSend = await getStream(fs.createReadStream(fullPath));

	const body = await got.post({
		body: fs.createReadStream(fullPath)
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
		body: ifStream
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
				}
			]
		}
	})), {
		instanceOf: UploadError,
		code: 'ERR_UPLOAD',
		message
	});
});
