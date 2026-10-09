import process from 'node:process';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {Handler} from 'express';
import ResponseLike from 'responselike';
import got, {Options, type Headers} from '../source/index.js';
import test from './helpers/test.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';

const supportsBrotli = typeof (process.versions as any).brotli === 'string';
const supportsZstd = typeof (process.versions as any).zstd === 'string';

const echoHeaders: Handler = (request, response) => {
	request.resume();
	response.end(JSON.stringify(request.headers));
};

const createOkRawHttpServer = async () => createRawHttpServer(socket => {
	socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
});

test('`user-agent`', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	assert.strictEqual(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
});

test('`accept-encoding`', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	const encodings = supportsBrotli ? ['gzip', 'deflate', 'br'] : ['gzip', 'deflate'];

	if (supportsZstd) {
		encodings.push('zstd');
	}

	assert.strictEqual(headers['accept-encoding'], encodings.join(', '));
});

test('does not override provided `accept-encoding`', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got({
		headers: {
			'accept-encoding': 'gzip',
		},
	}).json<Headers>();
	assert.strictEqual(headers['accept-encoding'], 'gzip');
});

test('does not remove user headers from `url` object argument', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const headers = (await got<Headers>(`http://${server.hostname}:${server.port}`, {
		responseType: 'json',
		headers: {
			'X-Request-Id': 'value',
		},
	})).body;

	const encodings = supportsBrotli ? ['gzip', 'deflate', 'br'] : ['gzip', 'deflate'];

	if (supportsZstd) {
		encodings.push('zstd');
	}

	assert.strictEqual(headers.accept, 'application/json');
	assert.strictEqual(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
	assert.strictEqual(headers['accept-encoding'], encodings.join(', '));
	assert.strictEqual(headers['x-request-id'], 'value');
});

test('does not set `accept-encoding` header when `options.decompress` is false', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got({
		decompress: false,
	}).json();
	// @ts-expect-error Error tests
	assert.strictEqual(Reflect.has(headers, 'accept-encoding'), false);
});

test('`accept` header with `json` option', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	let headers = await got('').json<Headers>();
	assert.strictEqual(headers.accept, 'application/json');

	headers = await got({
		headers: {
			accept: '',
		},
	}).json<Headers>();
	assert.strictEqual(headers.accept, '');
});

test('`host` header', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	assert.strictEqual(headers.host, `localhost:${server.port}`);
});

test('transforms names to lowercase', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const headers = (await got<Headers>({
		headers: {
			'ACCEPT-ENCODING': 'identity',
		},
		responseType: 'json',
	})).body;
	assert.strictEqual(headers['accept-encoding'], 'identity');
});

test('setting `content-length` to 0', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		headers: {
			'content-length': '0',
		},
		body: 'sup',
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '0');
});

test('computes `content-length` when the header is explicitly set to `undefined`', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post({
		headers: {
			'content-length': undefined,
		},
		body: 'sup',
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '3');
});

test('sets `content-length` to `0` when requesting PUT with empty body', withServer, async (_t, server, got) => {
	server.put('/', echoHeaders);

	const {body} = await got({
		method: 'PUT',
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], '0');
});

test('form manual `content-type` header', withServer, async (_t, server, got) => {
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
	assert.strictEqual(headers['content-type'], 'custom');
});

test('sets `content-type` header for native FormData', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormData();
	form.set('a', 'b');
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	assert.strictEqual((headers['content-type'] as string).startsWith('multipart/form-data'), true);
});

test('native FormData uses chunked transfer-encoding instead of content-length', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormData();
	form.set('a', 'b');
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], undefined);
	assert.strictEqual(headers['transfer-encoding'], 'chunked');
});

test('manual `content-type` header should be allowed with native FormData', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const form = new FormData();
	form.set('a', 'b');
	const {body} = await got.post({
		headers: {
			'content-type': 'custom',
		},
		body: form,
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-type'], 'custom');
});

test('stream as `options.body` does not set `content-length` header', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const fixture = path.resolve('test/fixtures/stream-content-length');
	const {body} = await got.post({
		body: fs.createReadStream(fixture),
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['content-length'], undefined);
});

test('buffer as `options.body` sets `content-length` header', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const buffer = Buffer.from('unicorn');
	const {body} = await got.post({
		body: buffer,
	});
	const headers = JSON.parse(body);
	assert.strictEqual(Number(headers['content-length']), buffer.length);
});

test('drops `content-length` when `transfer-encoding` is set manually', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		// Under load the body can arrive in several segments, so a data event can fire after the response was already written.
		const respond = () => {
			if (!socket.writableEnded) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		};

		socket.on('data', chunk => {
			rawRequest += String(chunk);

			const headerEnd = rawRequest.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				return;
			}

			const rawHeaders = rawRequest.slice(0, headerEnd).toLowerCase();
			if (rawHeaders.includes('transfer-encoding: chunked')) {
				if (rawRequest.includes('\r\n0\r\n\r\n')) {
					respond();
				}

				return;
			}

			const contentLength = /content-length:\s*(?<length>\d+)/v.exec(rawHeaders)?.groups?.length;
			if (!contentLength) {
				return;
			}

			const bodyStart = headerEnd + 4;
			if (rawRequest.length >= bodyStart + Number(contentLength)) {
				respond();
			}
		});
	});

	t.after(() => {
		void close();
	});

	await got.post(`http://127.0.0.1:${port}`, {
		body: 'wow',
		headers: {
			'content-length': '1',
			'transfer-encoding': 'chunked',
		},
	});

	const normalizedRawRequest = rawRequest.toLowerCase();
	assert.strictEqual(normalizedRawRequest.includes('transfer-encoding: chunked'), true);
	assert.strictEqual(normalizedRawRequest.includes('content-length:'), false);
	assert.strictEqual(normalizedRawRequest.includes('\r\n3\r\nwow\r\n0\r\n\r\n'), true);
});

type HeaderRequest = {request: (port: number) => ReturnType<typeof got>};

/**
Runs a request against a raw HTTP server and asserts the outcome. The two header macros only differ
in which assertion they make, so the assertion is the only parameter.
*/
const withRawServer = async (
	t: TestContext,
	{request}: HeaderRequest,
	assertion: (promise: Promise<unknown>) => Promise<unknown>,
) => {
	const {port, close} = await createOkRawHttpServer();

	t.after(() => {
		void close();
	});

	await assertion(request(port));
};

const duplicateHeaderRejectionMacro = (t: TestContext, options: HeaderRequest) =>
	withRawServer(t, options, async promise => assert.rejects(promise));

const singleSensitiveHeaderValueMacro = (t: TestContext, options: HeaderRequest) =>
	withRawServer(t, options, async promise => assert.doesNotReject(promise));

test('rejects duplicate `content-length` headers with conflicting values', duplicateHeaderRejectionMacro, {
	request: port => got.post(`http://127.0.0.1:${port}`, {
		body: 'abc',
		retry: {
			limit: 0,
		},
		headers: {
			'content-length': ['1', '2'],
		},
	}),
});

test('rejects duplicate `content-length` headers with matching values', duplicateHeaderRejectionMacro, {
	request: port => got.post(`http://127.0.0.1:${port}`, {
		body: 'abc',
		retry: {
			limit: 0,
		},
		headers: {
			'content-length': ['3', '3'],
		},
	}),
});

test('rejects duplicate `transfer-encoding` headers', duplicateHeaderRejectionMacro, {
	request: port => got.post(`http://127.0.0.1:${port}`, {
		body: 'abc',
		retry: {
			limit: 0,
		},
		headers: {
			'transfer-encoding': ['chunked', 'identity'],
		},
	}),
});

test('rejects duplicate `authorization` headers', duplicateHeaderRejectionMacro, {
	request: port => got(`http://127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			authorization: ['Basic aaa', 'Basic bbb'],
		},
	}),
});

test('rejects duplicate `proxy-authorization` headers', duplicateHeaderRejectionMacro, {
	request: port => got(`http://127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			'proxy-authorization': ['Basic aaa', 'Basic bbb'],
		},
	}),
});

test('accepts a single-element `content-length` header array', singleSensitiveHeaderValueMacro, {
	request: port => got.post(`http://127.0.0.1:${port}`, {
		body: 'abc',
		retry: {
			limit: 0,
		},
		headers: {
			'content-length': ['3'],
		},
	}),
});

test('single-element `authorization` header arrays override URL credentials', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		socket.on('data', chunk => {
			rawRequest += String(chunk);

			// Under load the headers and body can arrive in separate segments, so this runs twice.
			if (!socket.writableEnded && rawRequest.includes('\r\n\r\n')) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		});
	});

	t.after(() => {
		void close();
	});

	await got(`http://user:password@127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			authorization: ['Bearer token'],
		},
	});

	const normalizedRawRequest = rawRequest.toLowerCase();
	assert.strictEqual(normalizedRawRequest.includes('\r\nauthorization: bearer token\r\n'), true);
	assert.strictEqual(normalizedRawRequest.includes('\r\nauthorization: basic '), false);
});

test('accepts a single-element `transfer-encoding` header array', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		socket.on('data', chunk => {
			rawRequest += String(chunk);

			// Under load the headers and body can arrive in separate segments, so this runs twice.
			if (!socket.writableEnded && rawRequest.includes('\r\n\r\n')) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		});
	});

	t.after(() => {
		void close();
	});

	await got.post(`http://127.0.0.1:${port}`, {
		body: 'abc',
		retry: {
			limit: 0,
		},
		headers: {
			'transfer-encoding': ['chunked'],
		},
	});

	const normalizedRawRequest = rawRequest.toLowerCase();
	// eslint-disable-next-line regexp/no-super-linear-move -- The pattern is anchored, so each line start is the only candidate.
	assert.strictEqual(normalizedRawRequest.match(/^\s*transfer-encoding:/gmv)?.length, 1);
	assert.strictEqual(normalizedRawRequest.includes('\r\ntransfer-encoding: chunked\r\n'), true);
});

test('accepts a string `transfer-encoding` header with multiple codings', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		socket.on('data', chunk => {
			rawRequest += String(chunk);

			// Under load the headers and body can arrive in separate segments, so this runs twice.
			if (!socket.writableEnded && rawRequest.includes('\r\n\r\n')) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		});
	});

	t.after(() => {
		void close();
	});

	await got.post(`http://127.0.0.1:${port}`, {
		body: Buffer.from('abc'),
		retry: {
			limit: 0,
		},
		headers: {
			'transfer-encoding': 'foo; token="Ab,Cd", chunked',
		},
	});

	const normalizedRawRequest = rawRequest.toLowerCase();
	// eslint-disable-next-line regexp/no-super-linear-move -- The pattern is anchored, so each line start is the only candidate.
	assert.strictEqual(normalizedRawRequest.match(/^\s*transfer-encoding:/gmv)?.length, 1);
	assert.strictEqual(rawRequest.includes('\r\ntransfer-encoding: foo; token="Ab,Cd", chunked\r\n'), true);
});

test('accepts a single-element `authorization` header array', singleSensitiveHeaderValueMacro, {
	request: port => got(`http://127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			authorization: ['Basic aaa'],
		},
	}),
});

test('accepts a single-element `proxy-authorization` header array', singleSensitiveHeaderValueMacro, {
	request: port => got(`http://127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			'proxy-authorization': ['Basic aaa'],
		},
	}),
});

test('throws on null value headers', async _t => {
	await assert.rejects(got('https://example.com', {
		headers: {
			// @ts-expect-error For testing purposes
			'user-agent': null,
		},
	}), {
		message: 'Use `undefined` instead of `null` to delete the `user-agent` header',
	});
});

test('removes undefined value headers', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got({
		headers: {
			'user-agent': undefined,
		},
	});
	const headers = JSON.parse(body);
	assert.strictEqual(headers['user-agent'], undefined);
});

test('non-existent headers set to undefined are omitted', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const fixtureHeaders = {
		blah: undefined,
	} as const;

	const {body} = await got({
		headers: fixtureHeaders,
	});

	const headers = JSON.parse(body) as typeof fixtureHeaders;
	assert.strictEqual(Reflect.has(headers, 'blah'), false);
});

test('preserve port in host header if non-standard port', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const body = await got('').json<Headers>();
	assert.strictEqual(body.host, `localhost:${server.port}`);
});

test('strip port in host header if explicit standard port (:80) & protocol (HTTP)', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	// Start HTTP server on port 80 is not possible without root, so we test with local server instead
	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	assert.strictEqual(body.host, `localhost:${server.port}`);
});

test('strip port in host header if explicit standard port (:443) & protocol (HTTPS)', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	// Start HTTPS server on port 443 is not possible without root, so we test with local server instead
	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	assert.strictEqual(body.host, `localhost:${server.port}`);
});

test('strip port in host header if implicit standard port & protocol (HTTP)', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	assert.strictEqual(body.host, `localhost:${server.port}`);
});

test('strip port in host header if implicit standard port & protocol (HTTPS)', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	assert.strictEqual(body.host, `localhost:${server.port}`);
});

test('correctly encodes authorization header', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const {authorization} = await got('', {username: 'test@'}).json<{authorization: string}>();

	assert.strictEqual(authorization, `Basic ${Buffer.from('test@:').toString('base64')}`);
});

test('url passes if credentials contain special characters', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const {authorization} = await got('', {password: 't$es%t'}).json<{authorization: string}>();

	assert.strictEqual(authorization, `Basic ${Buffer.from(':t$es%t').toString('base64')}`);
});

// The URL parser does not validate percent-escapes in userinfo, so a malformed one must not throw.
for (const [userinfo, username, password] of [
	['a%zz@', 'a%zz', ''],
	['x:a%FF@', 'x', 'a%FF'],
	['us%20er:pa%20ss@', 'us er', 'pa ss'],
] as Array<[string, string, string]>) {
	test(`url credentials in ${userinfo} are exposed decoded`, _t => {
		const options = new Options(`http://${userinfo}example.com/`);

		assert.strictEqual(options.username, username);
		assert.strictEqual(options.password, password);
	});
}

for (const headerName of ['accept-encoding', 'Accept-Encoding']) {
	test(`explicit undefined omits generated ${headerName}`, async _t => {
		let calls = 0;
		await got('https://example.com', {
			headers: {[headerName]: undefined},
			request(url, options) {
				calls++;
				assert.strictEqual(Object.hasOwn(options.headers!, 'accept-encoding'), false);
				return new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('ok'),
					url: url.href,
				});
			},
		});

		assert.strictEqual(calls, 1);
	});
}

for (const headerValue of ['identity', '']) {
	test(`explicit accept-encoding value ${JSON.stringify(headerValue)} is preserved`, async _t => {
		let calls = 0;
		await got('https://example.com', {
			headers: {'accept-encoding': headerValue},
			request(url, options) {
				calls++;
				assert.strictEqual(Reflect.get(options.headers!, 'accept-encoding'), headerValue);
				return new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('ok'),
					url: url.href,
				});
			},
		});

		assert.strictEqual(calls, 1);
	});
}

test('accept-encoding is still generated by default', async _t => {
	let calls = 0;
	await got('https://example.com', {
		request(url, options) {
			calls++;
			assert.match(String(Reflect.get(options.headers!, 'accept-encoding')), /gzip/v);
			return new ResponseLike({
				statusCode: 200,
				headers: {},
				body: Buffer.from('ok'),
				url: url.href,
			});
		},
	});

	assert.strictEqual(calls, 1);
});

test('accepts a single-element `host` header array', singleSensitiveHeaderValueMacro, {
	request: port => got(`http://127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			host: [`127.0.0.1:${port}`],
		},
	}),
});

test('rejects duplicate `host` headers', duplicateHeaderRejectionMacro, {
	request: port => got(`http://127.0.0.1:${port}`, {
		retry: {
			limit: 0,
		},
		headers: {
			host: ['one.example.com', 'two.example.com'],
		},
	}),
});

test('a username containing a colon round-trips into the Basic credentials', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers.authorization ?? 'none');
	});

	// The URL stores the credentials percent-encoded; the Basic header is built from the decoded values, colons included.
	const {body} = await got('', {username: 'user:colon', password: 'p@ss'});
	assert.strictEqual(body, `Basic ${Buffer.from('user:colon:p@ss').toString('base64')}`);
});

test('number header values are stored and sent as strings', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.json({fromOption: request.headers['x-option'], fromHook: request.headers['x-hook']});
	});

	const readInHook: unknown[] = [];
	const body = await got('', {
		headers: {'x-option': 1},
		hooks: {
			beforeRequest: [
				options => {
					// A JavaScript caller can assign a number, which the `Headers` type does not allow.
					(options.headers as Record<string, unknown>)['x-hook'] = 2;
					readInHook.push(options.headers['x-option'], options.headers['x-hook']);
				},
			],
		},
	}).json();

	assert.deepStrictEqual(readInHook, ['1', '2']);
	assert.deepStrictEqual(body, {fromOption: '1', fromHook: '2'});
});

test('`responseType: json` sets `accept` without overriding an explicit one', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const defaultHeaders = (await got<Headers>({responseType: 'json'})).body;
	assert.strictEqual(defaultHeaders.accept, 'application/json');

	const explicitHeaders = (await got<Headers>({
		responseType: 'json',
		headers: {accept: 'application/vnd.api+json'},
	})).body;
	assert.strictEqual(explicitHeaders.accept, 'application/vnd.api+json');
});

test('the `json` option alone does not set `accept`', withServer, async (_t, server, got) => {
	server.post('/', echoHeaders);

	const headers = JSON.parse((await got.post({json: {a: 1}})).body) as Headers;

	assert.strictEqual(headers.accept, undefined);
	assert.strictEqual(headers['content-type'], 'application/json');
});

test('a gzip response is decompressed even when `accept-encoding` is overridden', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('x-accept-encoding', request.headers['accept-encoding'] ?? '');
		response.setHeader('content-encoding', 'gzip');
		response.end(gzipSync('decoded'));
	});

	const response = await got({headers: {'accept-encoding': 'identity'}});

	assert.strictEqual(response.headers['x-accept-encoding'], 'identity');
	assert.strictEqual(response.body, 'decoded');
});
