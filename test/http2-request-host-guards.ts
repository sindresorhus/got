import assert from 'node:assert/strict';
import got from '../source/index.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

test('HTTP/2 request.host remains writable metadata without changing the destination', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({':status': 200});
		stream.end(String(headers[':authority']));
	});
	t.after(server.close);
	const response = await got(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
	}).on('request', request => {
		request.host = 'application metadata';
		assert.strictEqual(request.host, 'application metadata');
	});
	assert.strictEqual(response.body, new URL(server.url).host);
});
