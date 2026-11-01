import assert from 'node:assert/strict';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import got from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

for (const compressed of [false, true]) {
	test(`piping after awaiting the response copies its status and headers with compression ${compressed}`, withServer, async (_t, server, got) => {
		server.get('/upstream', (_request, response) => {
			response.statusCode = 201;
			response.setHeader('x-upstream', 'retained');
			response.setHeader('x-private', 'removed');
			response.setHeader('set-cookie', ['first=one', 'second=two']);
			if (compressed) {
				response.setHeader('content-encoding', 'gzip');
				response.end(gzipSync('upstream body'));
			} else {
				response.end('upstream body');
			}
		});
		server.get('/proxy', async (_request, response) => {
			const upstream = got.stream('upstream').on('error', error => response.destroy(error));
			const [message] = await once(upstream, 'response');
			delete message.headers['x-private'];
			message.headers.connection = 'x-late-private';
			message.headers['x-late-private'] = 'removed';
			upstream.pipe(response);
		});

		const response = await got('proxy');
		assert.strictEqual(response.body, 'upstream body');
		assert.strictEqual(response.statusCode, 201);
		assert.strictEqual(response.headers['x-upstream'], 'retained');
		assert.strictEqual(response.headers['x-private'], undefined);
		assert.strictEqual(response.headers['x-late-private'], undefined);
		assert.deepStrictEqual(response.headers['set-cookie'], ['first=one', 'second=two']);
		assert.strictEqual(response.headers['content-encoding'], undefined);
	});
}

test('piping after awaiting the response prepares an HTTP/2 server response', withServer, async (t, upstream, preparedGot) => {
	upstream.get('/', (_request, response) => {
		response.writeHead(201, {'x-upstream': 'retained'});
		response.end('upstream body');
	});
	const downstream = await createHttp2TestServer(() => {});
	t.after(downstream.close);
	downstream.server.on('request', async (_request, response) => {
		const request = preparedGot.stream('').on('error', error => response.destroy(error));
		await once(request, 'response');
		request.pipe(response);
	});

	const response = await got(downstream.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
	});
	assert.strictEqual(response.body, 'upstream body');
	assert.strictEqual(response.statusCode, 201);
	assert.strictEqual(response.headers['x-upstream'], 'retained');
});
