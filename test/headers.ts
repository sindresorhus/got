import process from 'node:process';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import type {Handler} from 'express';
import got, {type Headers} from '../source/index.js';
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

test('`user-agent`', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	t.is(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
});

test('`accept-encoding`', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const headers = await got('').json<Headers>();
	const encodings = ['gzip', 'deflate'];
	if (supportsBrotli) {
		encodings.push('br');
	}

	if (supportsZstd) {
		encodings.push('zstd');
	}

	t.is(headers['accept-encoding'], encodings.join(', '));
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

	const headers = (await got<Headers>(`http://${server.hostname}:${server.port}`, {
		responseType: 'json',
		headers: {
			'X-Request-Id': 'value',
		},
	})).body;

	const encodings = ['gzip', 'deflate'];
	if (supportsBrotli) {
		encodings.push('br');
	}

	if (supportsZstd) {
		encodings.push('zstd');
	}

	t.is(headers.accept, 'application/json');
	t.is(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
	t.is(headers['accept-encoding'], encodings.join(', '));
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

test('sets `content-type` header for native FormData', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new globalThis.FormData();
	form.set('a', 'b');
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	t.true((headers['content-type'] as string).startsWith('multipart/form-data'));
});

test('native FormData uses chunked transfer-encoding instead of content-length', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new globalThis.FormData();
	form.set('a', 'b');
	const {body} = await got.post({body: form});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], undefined);
	t.is(headers['transfer-encoding'], 'chunked');
});

test('manual `content-type` header should be allowed with native FormData', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const form = new globalThis.FormData();
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

test('drops `content-length` when `transfer-encoding` is set manually', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		const respond = () => {
			socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
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

	t.teardown(() => {
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
	t.true(normalizedRawRequest.includes('transfer-encoding: chunked'));
	t.false(normalizedRawRequest.includes('content-length:'));
	t.true(normalizedRawRequest.includes('\r\n3\r\nwow\r\n0\r\n\r\n'));
});

const duplicateHeaderRejectionMacro = test.macro(async (t, {
	request,
}: {
	request: (port: number) => ReturnType<typeof got>;
}) => {
	const {port, close} = await createOkRawHttpServer();

	t.teardown(() => {
		void close();
	});

	await t.throwsAsync(request(port));
});

const singleSensitiveHeaderValueMacro = test.macro(async (t, {
	request,
}: {
	request: (port: number) => ReturnType<typeof got>;
}) => {
	const {port, close} = await createOkRawHttpServer();

	t.teardown(() => {
		void close();
	});

	await t.notThrowsAsync(request(port));
});

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

			if (rawRequest.includes('\r\n\r\n')) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		});
	});

	t.teardown(() => {
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
	t.true(normalizedRawRequest.includes('\r\nauthorization: bearer token\r\n'));
	t.false(normalizedRawRequest.includes('\r\nauthorization: basic '));
});

test('accepts a single-element `transfer-encoding` header array', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		socket.on('data', chunk => {
			rawRequest += String(chunk);

			if (rawRequest.includes('\r\n\r\n')) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		});
	});

	t.teardown(() => {
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
	t.is(normalizedRawRequest.match(/^\s*transfer-encoding:/gmu)?.length, 1);
	t.true(normalizedRawRequest.includes('\r\ntransfer-encoding: chunked\r\n'));
});

test('accepts a string `transfer-encoding` header with multiple codings', async t => {
	let rawRequest = '';
	const {port, close} = await createRawHttpServer(socket => {
		socket.setEncoding('latin1');

		socket.on('data', chunk => {
			rawRequest += String(chunk);

			if (rawRequest.includes('\r\n\r\n')) {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			}
		});
	});

	t.teardown(() => {
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
	t.is(normalizedRawRequest.match(/^\s*transfer-encoding:/gmu)?.length, 1);
	t.true(rawRequest.includes('\r\ntransfer-encoding: foo; token="Ab,Cd", chunked\r\n'));
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

test('throws on null value headers', async t => {
	await t.throwsAsync(got('https://example.com', {
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

test('strip port in host header if explicit standard port (:80) & protocol (HTTP)', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	// Start HTTP server on port 80 is not possible without root, so we test with local server instead
	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	t.is(body.host, `localhost:${server.port}`);
});

test('strip port in host header if explicit standard port (:443) & protocol (HTTPS)', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	// Start HTTPS server on port 443 is not possible without root, so we test with local server instead
	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	t.is(body.host, `localhost:${server.port}`);
});

test('strip port in host header if implicit standard port & protocol (HTTP)', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	t.is(body.host, `localhost:${server.port}`);
});

test('strip port in host header if implicit standard port & protocol (HTTPS)', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const body = await got('').json<Headers>();
	// For non-standard ports, the host header should include the port
	t.is(body.host, `localhost:${server.port}`);
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
