import process from 'node:process';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import type {Handler} from 'express';
import FormData from 'form-data';
import {FormDataEncoder} from 'form-data-encoder';
import {FormData as FormDataNode} from 'formdata-node';
import got, {type Headers} from '../source/index.js';
import withServer from './helpers/with-server.js';

const supportsBrotli = typeof (process.versions as any).brotli === 'string';

const echoHeaders: Handler = (request, response) => {
	request.resume();
	response.end(JSON.stringify(request.headers));
};

test('`user-agent`', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	t.is(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
});

test('`accept-encoding`', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	t.is(headers['accept-encoding'], supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate');
});

test('does not override provided `accept-encoding`', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got({
		headers: {
			'accept-encoding': 'gzip',
		},
	}).json<Headers>();
	t.is(headers['accept-encoding'], 'gzip');
});

test('does not remove user headers from `url` object argument', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const headers = (await got<Headers>({
		url: `http://${server.hostname}:${server.port}`,
		responseType: 'json',
		headers: {
			'X-Request-Id': 'value',
		},
	})).body;

	t.is(headers.accept, 'application/json');
	t.is(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
	t.is(headers['accept-encoding'], supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate');
	t.is(headers['x-request-id'], 'value');
});

test('does not set `accept-encoding` header when `options.decompress` is false', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got({
		decompress: false,
	}).json();
	// @ts-expect-error Error tests
	t.false(Reflect.has(headers, 'accept-encoding'));
});

test('`accept` header with `json` option', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let headers = await got('').json<Headers>();
	t.is(headers.accept, 'application/json');

	headers = await got({
		headers: {
			accept: '',
		},
	}).json<Headers>();
	t.is(headers.accept, '');
});

test('`host` header', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	t.is(headers.host, `localhost:${server.port}`);
});

test('transforms names to lowercase', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = (await got<Headers>({
		headers: {
			'ACCEPT-ENCODING': 'identity',
		},
		responseType: 'json',
	})).body;
	t.is(headers['accept-encoding'], 'identity');
});

test('setting `content-length` to 0', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		headers: {
			'content-length': '0',
		},
		body: 'sup',
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '0');
});

test('sets `content-length` to `0` when requesting PUT with empty body', withServer, async (t, server, got) => {
	server.put('/', echoHeaders);

	const {body} = await got({
		method: 'PUT',
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '0');
});

test('form manual `content-type` header', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		headers: {
			'content-type': 'custom',
		},
		form: {
			a: 1,
		},
	});
	const headers = JSON.parse(body);
	t.is(headers['content-type'], 'custom');
});

test('form-data manual `content-type` header', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormData();
	form.append('a', 'b');
	const {body} = await got.post({
		headers: {
			'content-type': 'custom',
		},
		body: form,
	});
	const headers = JSON.parse(body);
	t.is(headers['content-type'], 'custom');
});

test('form-data automatic `content-type` header', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormData();
	form.append('a', 'b');
	const {body} = await got.post({
		body: form,
	});
	const headers = JSON.parse(body);
	t.is(headers['content-type'], `multipart/form-data; boundary=${form.getBoundary()}`);
});

test('form-data sets `content-length` header', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormData();
	form.append('a', 'b');
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '157');
});

test('sets `content-type` header for spec-compliant FormData', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormDataNode();
	form.set('a', 'b');
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	t.true((headers['content-type'] as string).startsWith('multipart/form-data'));
});

test('sets `content-length` header for spec-compliant FormData', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormDataNode();
	form.set('a', 'b');
	const encoder = new FormDataEncoder(form);
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], encoder.headers['Content-Length']);
});

test('manual `content-type` header should be allowed with spec-compliant FormData', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormDataNode();
	form.set('a', 'b');
	const {body} = await got.post({
		headers: {
			'content-type': 'custom',
		},
		body: form,
	});
	const headers = JSON.parse(body);
	t.is(headers['content-type'], 'custom');
});

test('stream as `options.body` does not set `content-length` header', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const fixture = path.resolve('test/fixtures/stream-content-length');
	const {body} = await got.post({
		body: fs.createReadStream(fixture),
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], undefined);
});

test('buffer as `options.body` sets `content-length` header', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const buffer = Buffer.from('unicorn');
	const {body} = await got.post({
		body: buffer,
	});
	const headers = JSON.parse(body);
	t.is(Number(headers['content-length']), buffer.length);
});

test('throws on null value headers', async t => {
	await t.throwsAsync(got({
		url: 'https://example.com',
		headers: {
			// @ts-expect-error For testing purposes
			'user-agent': null,
		},
	}), {
		message: 'Use `undefined` instead of `null` to delete the `user-agent` header',
	});
});

test('removes undefined value headers', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got({
		headers: {
			'user-agent': undefined,
		},
	});
	const headers = JSON.parse(body);
	t.is(headers['user-agent'], undefined);
});

test('non-existent headers set to undefined are omitted', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const fixtureHeaders = {
		blah: undefined,
	} as const;

	const {body} = await got({
		headers: fixtureHeaders,
	});

	const headers = JSON.parse(body) as typeof fixtureHeaders;
	t.false(Reflect.has(headers, 'blah'));
});

test('preserve port in host header if non-standard port', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const body = await got('').json<Headers>();
	t.is(body.host, `localhost:${server.port}`);
});

test('strip port in host header if explicit standard port (:80) & protocol (HTTP)', async t => {
	const body = await got('http://httpbin.org:80/headers').json<{headers: Headers}>();
	t.is(body.headers.Host, 'httpbin.org');
});

test('strip port in host header if explicit standard port (:443) & protocol (HTTPS)', async t => {
	const body = await got('https://httpbin.org:443/headers').json<{headers: Headers}>();
	t.is(body.headers.Host, 'httpbin.org');
});

test('strip port in host header if implicit standard port & protocol (HTTP)', async t => {
	const body = await got('http://httpbin.org/headers').json<{headers: Headers}>();
	t.is(body.headers.Host, 'httpbin.org');
});

test('strip port in host header if implicit standard port & protocol (HTTPS)', async t => {
	const body = await got('https://httpbin.org/headers').json<{headers: Headers}>();
	t.is(body.headers.Host, 'httpbin.org');
});

test('correctly encodes authorization header', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {authorization} = await got('', {username: 'test@'}).json<{authorization: string}>();

	t.is(authorization, `Basic ${Buffer.from('test@:').toString('base64')}`);
});

test('url passes if credentials contain special characters', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {authorization} = await got('', {password: 't$es%t'}).json<{authorization: string}>();

	t.is(authorization, `Basic ${Buffer.from(':t$es%t').toString('base64')}`);
});
