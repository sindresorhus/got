import assert from 'node:assert/strict';
import https from 'node:https';
import got from '../source/index.js';
import test from './helpers/test.js';
import {withHttpsServer} from './helpers/with-server.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

for (const agent of [{}, {http2: false as const}, {http: false as const}]) {
	test(`a replacement agent map ${JSON.stringify(agent)} preserves real HTTP/2 requests`, async t => {
		const server = await createHttp2TestServer(stream => {
			stream.respond();
			stream.end('http2');
		});
		t.after(server.close);
		const response = await got(server.url, {
			http2: true,
			https: {rejectUnauthorized: false},
			hooks: {
				beforeRequest: [options => {
					options.agent = agent;
				}],
			},
		});
		assert.strictEqual(response.httpVersion, '2.0');
		assert.strictEqual(response.body, 'http2');
	});
}

for (const http2 of [false, true]) {
	test(`a replacement custom HTTPS agent is used with http2 ${http2}`, withHttpsServer(), async (t, server, got) => {
		const agent = new https.Agent();
		t.after(() => {
			agent.destroy();
		});
		const createConnection = t.mock.method(agent, 'createConnection');
		let connections = 0;
		server.https.on('secureConnection', () => {
			connections++;
		});
		server.get('/', (_request, response) => {
			response.end('custom agent');
		});
		const response = await got('', {
			http2,
			hooks: {
				beforeRequest: [options => {
					options.agent = {https: agent};
				}],
			},
		});
		assert.strictEqual(response.body, 'custom agent');
		assert.strictEqual(response.httpVersion, '1.1');
		assert.strictEqual(createConnection.mock.calls.length, 1);
		assert.strictEqual(connections, 1);
	});
}

test('explicit HTTPS agent opt-out still permits negotiated HTTP/1 fallback', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('unpooled');
	});
	const response = await got('', {
		http2: true,
		hooks: {
			beforeRequest: [options => {
				options.agent = {https: false};
			}],
		},
	});
	assert.strictEqual(response.body, 'unpooled');
	assert.strictEqual(response.httpVersion, '1.1');
});
