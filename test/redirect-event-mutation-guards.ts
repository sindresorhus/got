import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {Readable} from 'node:stream';
import getStream from 'get-stream';
import {type Options, type NormalizedOptions, RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const api of ['promise', 'stream']) {
	test(`a ${api} beforeRedirect hook can explicitly retain the same credential and upload values for another origin`, withServer, async (t, source, got) => {
		await withServer(t, async (_t, receiver) => {
			source.put('/start', async (request, response) => {
				assert.strictEqual(await getStream(request), 'explicit upload');
				response.writeHead(302, {location: '/next'}).end();
			});
			receiver.put('/next', async (request, response) => {
				response.end(JSON.stringify({authorization: request.headers.authorization, cookie: request.headers.cookie, body: await getStream(request)}));
			});
			const update = (options: NormalizedOptions) => {
				assert.ok(options.url instanceof URL);
				options.url.host = new URL(receiver.url).host;
				options.username = 'client';
				options.password = 'secret';
				options.body = 'explicit upload';
				options.headers.cookie = 'explicit=cookie';
			};

			const options = {
				body: 'explicit upload', username: 'client', password: 'secret', headers: {cookie: 'explicit=cookie'}, retry: {limit: 0},
				hooks: {beforeRedirect: [update]},
			};
			const body = api === 'promise'
				? await got.put('start', options).text()
				: await getStream(got.stream.put('start', options));
			assert.deepStrictEqual(JSON.parse(body), {authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`, cookie: 'explicit=cookie', body: 'explicit upload'});
		});
	});
}

for (const api of ['promise', 'stream']) {
	test(`a ${api} same-origin redirect listener observes the credentials and upload sent on the wire`, withServer, async (_t, server, got) => {
		server.put('/start', async (request, response) => {
			assert.strictEqual(await getStream(request), 'same-origin upload');
			response.writeHead(307, {location: '/next'}).end();
		});
		server.put('/next', async (request, response) => {
			response.end(JSON.stringify({authorization: request.headers.authorization, body: await getStream(request)}));
		});
		let observed: unknown;
		const observe = (options: Options) => {
			observed = {authorization: options.headers.authorization, body: options.body};
		};

		const options = {
			body: 'same-origin upload', username: 'client', password: 'secret', retry: {limit: 0},
		};
		const body = api === 'promise'
			? await got.put('start', options).on('redirect', observe).text()
			: await getStream(got.stream.put('start', options).on('redirect', observe));
		const expected = {authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`, body: 'same-origin upload'};
		assert.deepStrictEqual(JSON.parse(body), expected);
		assert.deepStrictEqual(observed, expected);
	});

	test(`a throwing ${api} redirect listener releases the body accepted by beforeRedirect and reports the original cause`, withServer, async (_t, server, got) => {
		server.put('/start', async (request, response) => {
			request.resume();
			response.writeHead(307, {location: '/next'}).end();
		});
		const cause = new Error('The redirect observer failed');
		const replacement = Readable.from(['replacement']);
		let errors = 0;
		const update = () => {
			throw cause;
		};

		const options = {
			body: 'initial', retry: {limit: 0}, hooks: {
				beforeRedirect: [(options: NormalizedOptions) => {
					options.body = replacement;
				}],
				beforeError: [(error: RequestError) => {
					errors++;
					return error;
				}],
			},
		};
		const operation = api === 'promise'
			? got.put('start', options).on('redirect', update)
			: got.stream.put('start', options).on('redirect', update).toArray();
		await assert.rejects(operation, error => error instanceof RequestError && error.cause === cause);
		assert.strictEqual(replacement.destroyed, true);
		assert.strictEqual(errors, 1);
	});
}

test('a removed promise redirect listener does not cause payload rollback copies', withServer, async (t, server, got) => {
	const body = Buffer.from('payload');
	const copy = t.mock.method(Uint8Array.prototype, 'slice');
	server.put('/start', async (request, response) => {
		assert.strictEqual(await getStream(request), 'payload');
		response.writeHead(307, {location: '/next'}).end();
	});
	server.put('/next', async (request, response) => {
		response.end(await getStream(request));
	});
	let observations = 0;
	const observe = () => {
		observations++;
	};

	const request = got.put('start', {body}).on('redirect', observe).off('redirect', observe);
	assert.strictEqual(await request.text(), 'payload');
	assert.strictEqual(observations, 0);
	assert.strictEqual(copy.mock.calls.filter(call => call.this instanceof Uint8Array && call.this.buffer === body.buffer).length, 0);
});

test('a promise once redirect listener runs only on the first hop across a retry', withServer, async (_t, server, got) => {
	let attempts = 0;
	server.get('/start', (_request, response) => {
		attempts++;
		if (attempts === 1) {
			response.status(503).end('retry');
			return;
		}

		response.writeHead(302, {location: '/middle'}).end();
	});
	server.get('/middle', (_request, response) => {
		response.writeHead(302, {location: '/next'}).end();
	});
	server.get('/next', (_request, response) => {
		response.end('done');
	});
	const observed: string[] = [];
	const response = await got('start', {retry: {limit: 1, calculateDelay: () => 1}}).once('redirect', options => {
		assert.ok(options.url instanceof URL);
		observed.push(options.url.pathname);
	});
	assert.strictEqual(response.body, 'done');
	assert.strictEqual(attempts, 2);
	assert.deepStrictEqual(observed, ['/middle']);
});
