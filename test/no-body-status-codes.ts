import {Agent} from 'node:http';
import type {Handler} from 'express';
import getStream from 'get-stream';
import test from 'ava';
import withServer from './helpers/with-server.js';

test('does not decompress 304 Not Modified responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(304, {
			'content-encoding': 'gzip',
		});
		response.end();
	});

	// Should not hang even though the response has content-encoding header but no body
	const response = await got({
		throwHttpErrors: false,
		timeout: {
			request: 1000, // 1 second timeout to catch hangs
		},
	});

	t.is(response.statusCode, 304);
	t.is(response.body, '');
});

test('does not decompress 204 No Content responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(204, {
			'content-encoding': 'gzip',
		});
		response.end();
	});

	const response = await got({
		throwHttpErrors: false,
		timeout: {
			request: 1000,
		},
	});

	t.is(response.statusCode, 204);
	t.is(response.body, '');
});

test('does not decompress 205 Reset Content responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(205, {
			'content-encoding': 'gzip',
		});
		response.end();
	});

	const response = await got({
		throwHttpErrors: false,
		timeout: {
			request: 1000,
		},
	});

	t.is(response.statusCode, 205);
	t.is(response.body, '');
});

test('does not decompress HEAD responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		// HEAD responses should never have a body, regardless of status code
		response.writeHead(200, {
			'content-encoding': 'gzip',
			'content-type': 'text/plain',
			'content-length': '11', // Would be the length if it had a body
		});
		response.end();
	});

	const response = await got.head({
		throwHttpErrors: false,
		timeout: {
			request: 1000,
		},
	});

	t.is(response.statusCode, 200);
	t.is(response.body, '');
});

// Note: 1xx responses are handled specially by Node.js and typically
// don't reach user code in the same way as other status codes

// RFC 9110 sections 6.4.1 and 8.6: HEAD and 304 can describe a representation without transferring it; 204 cannot carry Content-Length.
for (const {name, method, statusCode} of [
	{name: 'HEAD success', method: 'HEAD', statusCode: 200},
	{name: 'HEAD error', method: 'HEAD', statusCode: 404},
	{name: '204', method: 'GET', statusCode: 204},
	{name: '205', method: 'GET', statusCode: 205},
	{name: '304', method: 'GET', statusCode: 304},
]) {
	const handler: Handler = (_request, response) => {
		response.statusCode = statusCode;
		response.setHeader('content-type', 'application/json');
		response.setHeader('content-encoding', 'gzip');
		response.setHeader('etag', '"representation"');
		if (statusCode !== 204) {
			response.setHeader('content-length', statusCode === 205 ? '0' : '123');
		}

		response.end();
	};

	const options = {
		method,
		throwHttpErrors: false,
		strictContentLength: true,
		retry: {limit: 0},
		headers: statusCode === 304 ? {'if-none-match': '"representation"'} : {},
	};

	test(`${name} skips JSON parsing and preserves representation metadata`, withServer, async (t, server, got) => {
		server.all('/', handler);
		let parseCalls = 0;
		const response = await got('', {
			...options,
			responseType: 'json',
			parseJson() {
				parseCalls++;
				throw new Error('A bodyless response must not enter the JSON parser');
			},
		});

		t.is(parseCalls, 0);
		t.is(response.body, '');
		t.is(response.rawBody.byteLength, 0);
		t.is(response.statusCode, statusCode);
		t.is(response.headers.etag, '"representation"');
		t.is(response.headers['content-encoding'], 'gzip');
		t.is(response.headers['content-length'], statusCode === 204 ? undefined : (statusCode === 205 ? '0' : '123'));
	});

	test(`${name} returns empty bytes with decompression disabled`, withServer, async (t, server, got) => {
		server.all('/', handler);
		const response = await got('', {...options, responseType: 'buffer', decompress: false});

		t.true(response.body instanceof Uint8Array);
		t.is(response.body.byteLength, 0);
		t.is(response.rawBody.byteLength, 0);
		t.is(response.statusCode, statusCode);
		t.is(response.ok, statusCode !== 404);
	});

	test(`${name} streams end without decoded body chunks`, withServer, async (t, server, got) => {
		server.all('/', handler);
		const request = got.stream('', options);
		let responses = 0;
		let chunks = 0;
		request.on('response', response => {
			responses++;
			t.is(response.statusCode, statusCode);
			t.is(response.headers.etag, '"representation"');
		});
		request.on('data', () => {
			chunks++;
		});

		t.is(await getStream(request), '');
		t.is(responses, 1);
		t.is(chunks, 0);
	});
}

for (const method of ['HEAD', 'GET']) {
	test(`${method} bodyless metadata does not consume the next keep-alive response`, withServer, async (t, server, got) => {
		const agent = new Agent({keepAlive: true, maxSockets: 1});
		t.teardown(() => {
			agent.destroy();
		});
		const sockets: unknown[] = [];
		server.all('/metadata', (request, response) => {
			sockets.push(request.socket);
			response.writeHead(method === 'HEAD' ? 200 : 304, {'content-length': '123', etag: '"version"'});
			response.end();
		});
		server.get('/body', (request, response) => {
			sockets.push(request.socket);
			response.end('next response');
		});
		const client = got.extend({agent: {http: agent}, retry: {limit: 0}, strictContentLength: true});
		const metadata = await client('metadata', {method, headers: {'if-none-match': '"version"'}});
		const response = await client('body');

		t.is(metadata.body, '');
		t.is(metadata.headers['content-length'], '123');
		t.is(response.body, 'next response');
		t.is(sockets.length, 2);
		t.is(sockets[0], sockets[1]);
	});
}
