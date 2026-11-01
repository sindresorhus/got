import assert from 'node:assert/strict';
import got from '../source/index.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('a JSON shortcut keeps an explicitly omitted Accept while a request hook is pending', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({accept: request.headers.accept});
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => {
		release.resolve();
	});
	const pending = got('', {
		headers: {accept: undefined},
		hooks: {
			beforeRequest: [async () => {
				entered.resolve();
				await release.promise;
			}],
		},
	});
	await entered.promise;
	const result = pending.json();
	release.resolve();
	assert.deepStrictEqual(await result, {});
});

test('a JSON shortcut keeps an explicitly omitted Accept while an HTTP/2 request hook is pending', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({':status': 200});
		stream.end(JSON.stringify({accept: headers.accept}));
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(async () => {
		release.resolve();
		await server.close();
	});
	const pending = got(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		headers: {accept: undefined},
		hooks: {
			beforeRequest: [async () => {
				entered.resolve();
				await release.promise;
			}],
		},
	});
	await entered.promise;
	const result = pending.json();
	release.resolve();
	assert.deepStrictEqual(await result, {});
});
