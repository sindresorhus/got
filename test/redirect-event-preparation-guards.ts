import assert from 'node:assert/strict';
import getStream from 'get-stream';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('a redirect observer sees refreshed framing after a hook replaces the upload', withServer, async (_t, server, got) => {
	server.put('/start', async (request, response) => {
		assert.strictEqual(await getStream(request), 'short');
		response.writeHead(307, {location: '/next'}).end();
	});
	server.put('/next', async (request, response) => {
		response.end(await getStream(request));
	});
	let observedLength: string | string[] | undefined;
	const response = await got.put('start', {
		body: 'short',
		hooks: {
			beforeRedirect: [options => {
				options.body = 'longer replacement';
			}],
		},
	}).on('redirect', options => {
		observedLength = options.headers['content-length'];
	});
	assert.strictEqual(response.body, 'longer replacement');
	assert.strictEqual(observedLength, '18');
});

test('a redirect observer sees stripped inherited state after a hook changes origin', withServer, async (t, source, got) => {
	await withServer(t, async (_t, receiver) => {
		source.put('/start', async (request, response) => {
			assert.strictEqual(await getStream(request), 'private upload');
			response.writeHead(302, {location: '/next'}).end();
		});
		receiver.put('/next', async (request, response) => {
			assert.strictEqual(await getStream(request), '');
			response.end('done');
		});
		let observed: unknown;
		await got.put('start', {
			body: 'private upload',
			username: 'client',
			password: 'secret',
			headers: {cookie: 'private=cookie'},
			hooks: {
				beforeRedirect: [options => {
					assert.ok(options.url instanceof URL);
					options.url.host = new URL(receiver.url).host;
				}],
			},
		}).on('redirect', options => {
			observed = {
				username: options.username, password: options.password, authorization: options.headers.authorization, cookie: options.headers.cookie, body: options.body,
			};
		});
		assert.deepStrictEqual(observed, {
			username: '', password: '', authorization: undefined, cookie: undefined, body: undefined,
		});
	});
});
