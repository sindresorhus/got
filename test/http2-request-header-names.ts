import assert from 'node:assert/strict';
import type {ClientRequest} from 'node:http';
import got from '../source/index.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

for (const api of ['promise', 'stream']) {
	test(`HTTP/2 raw header names are available through the ${api} request event`, async t => {
		const server = await createHttp2TestServer((stream, headers) => {
			stream.respond({':status': 200});
			stream.end(JSON.stringify(headers));
		});
		t.after(server.close);
		let notifications = 0;
		const inspectHeaders = (request: ClientRequest) => {
			notifications++;
			request.setHeader('X-Dynamic', ['first', 'second']);
			request.removeHeader('X-Removed');
			const names = request.getRawHeaderNames();
			assert.ok(names.includes('x-signed'));
			assert.ok(names.includes('x-dynamic'));
			assert.strictEqual(names.includes('x-removed'), false);
			assert.strictEqual(names.some(name => name.startsWith(':')), false);
			assert.strictEqual(names.includes('connection'), false);
			assert.strictEqual(names.includes('x-hop'), false);
			assert.strictEqual(names.includes('te'), false);
			assert.strictEqual(new Set(names).size, names.length);
			assert.deepStrictEqual(names, request.getHeaderNames());
			// HTTP/2 sends lower-case field names, and enumeration must not expose mutable header state.
			assert.ok(names.every(name => name === name.toLowerCase()));
			names.splice(0, names.length, 'x-injected');
			assert.strictEqual(request.hasHeader('x-injected'), false);
			assert.ok(request.getRawHeaderNames().includes('x-signed'));
		};

		const options = {
			http2: true,
			agent: {http2: false as const},
			https: {rejectUnauthorized: false},
			retry: {limit: 0},
			headers: {
				'X-Signed': 'value', 'x-removed': 'remove', connection: 'x-hop', 'x-hop': 'drop', te: 'gzip',
			},
		};
		const body = api === 'promise'
			? await got(server.url, options).on('request', inspectHeaders).text()
			: (await got.stream(server.url, options).on('request', inspectHeaders).toArray()).join('');
		const received = JSON.parse(body) as Record<string, string>;
		assert.strictEqual(received['x-signed'], 'value');
		assert.strictEqual(received['x-dynamic'], 'first, second');
		assert.strictEqual(received['x-removed'], undefined);
		assert.strictEqual(received['x-injected'], undefined);
		assert.strictEqual(received['x-hop'], undefined);
		assert.strictEqual(notifications, 1);
	});
}

test('HTTP/2 raw header names remain available after sending a request with no regular headers', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({':status': 200});
		stream.end(JSON.stringify(Object.keys(headers).filter(name => !name.startsWith(':'))));
	});
	t.after(server.close);
	let nativeRequest: ClientRequest | undefined;
	const response = await got(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		retry: {limit: 0},
		headers: {'user-agent': undefined, 'accept-encoding': undefined},
	}).on('request', request => {
		nativeRequest = request;
		assert.deepStrictEqual(request.getRawHeaderNames(), []);
	});
	assert.deepStrictEqual(JSON.parse(response.body), []);
	assert.ok(nativeRequest);
	assert.strictEqual(nativeRequest.headersSent, true);
	assert.strictEqual(nativeRequest.writableFinished, true);
	assert.deepStrictEqual(nativeRequest.getRawHeaderNames(), []);
});
