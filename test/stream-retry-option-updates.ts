import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import process from 'node:process';
import {Readable, PassThrough} from 'node:stream';
import {UploadError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const replaceCredentials of [false, true]) {
	test(`a retry stream ${replaceCredentials ? 'uses explicit destination credentials' : 'omits inherited credentials'} when its factory changes origin`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.status(503).end('retry elsewhere');
		});
		await withServer(t, async (_t, destination) => {
			destination.get('/', (request, response) => {
				response.json({authorization: request.headers.authorization ?? '', cookie: request.headers.cookie ?? ''});
			});
			const result = Promise.withResolvers<string>();
			const request = got.stream('', {
				username: 'source-user', password: 'source-password', headers: {cookie: 'session=source'},
				retry: {limit: 1, backoffLimit: 0, noise: 0},
			});
			request.on('error', result.reject);
			request.on('retry', (_retryCount, _error, createRetryStream) => {
				const replacement = createRetryStream({
					url: destination.url,
					...(replaceCredentials && {username: 'destination-user', password: 'destination-password'}),
				});
				void replacement.toArray().then((chunks: Uint8Array[]) => {
					result.resolve(Buffer.concat(chunks).toString());
				}).catch(result.reject);
			});
			request.resume();
			assert.deepStrictEqual(JSON.parse(await result.promise), {
				authorization: replaceCredentials ? `Basic ${Buffer.from('destination-user:destination-password').toString('base64')}` : '',
				cookie: '',
			});
		});
	});
}

test('a retry stream applies relative URLs and credential overrides without changing the failed attempt', withServer, async (_t, server, got) => {
	server.get('/source', (_request, response) => {
		response.status(503).end('retry');
	});
	server.get('/destination', (request, response) => {
		response.end(`${request.url}:${request.headers.authorization}`);
	});
	const result = Promise.withResolvers<string>();
	const request = got.stream('source', {
		username: 'source-user', password: 'source-password',
		retry: {limit: 1, backoffLimit: 0, noise: 0},
	});
	request.on('error', result.reject);
	request.on('retry', (_retryCount, error, createRetryStream) => {
		const previousUrl = error.options.url!.toString();
		const replacement = createRetryStream({url: '/destination?next=yes', username: 'destination-user', password: 'destination-password'});
		assert.strictEqual(error.options.url!.toString(), previousUrl);
		assert.strictEqual(error.options.username, 'source-user');
		void replacement.toArray().then((chunks: Uint8Array[]) => {
			result.resolve(Buffer.concat(chunks).toString());
		}).catch(result.reject);
	});
	request.resume();
	assert.strictEqual(await result.promise, `/destination?next=yes:Basic ${Buffer.from('destination-user:destination-password').toString('base64')}`);
});

for (const replaceBody of [false, true]) {
	test(`a retry stream ${replaceBody ? 'sends an explicit replacement upload' : 'drops the inherited upload'} on an origin change`, withServer, async (t, server, got) => {
		server.post('/', async (request, response) => {
			assert.strictEqual(Buffer.concat(await request.toArray()).toString(), 'source payload');
			response.status(503).end('retry');
		});
		await withServer(t, async (_t, destination) => {
			destination.post('/', async (request, response) => {
				response.end(Buffer.concat(await request.toArray()));
			});
			const result = Promise.withResolvers<string>();
			const body = Readable.from(['replacement payload']);
			t.after(() => {
				body.destroy();
			});
			const request = got.stream.post('', {
				body: 'source payload', retry: {
					limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0,
				},
			});
			request.on('error', result.reject);
			request.on('retry', (_retryCount, _error, createRetryStream) => {
				const replacement = createRetryStream({url: destination.url, ...(replaceBody && {body})});
				if (!replaceBody) {
					// With no configured payload, the POST stream remains writable until the caller ends it.
					replacement.end();
				}

				void replacement.toArray().then((chunks: Uint8Array[]) => {
					result.resolve(Buffer.concat(chunks).toString());
				}).catch(result.reject);
			});
			request.resume();
			assert.strictEqual(await result.promise, replaceBody ? 'replacement payload' : '');
			if (replaceBody) {
				assert.strictEqual(body.readableEnded, true);
			}
		});
	});
}

test('a rejected retry update releases its accepted replacement upload through the next request', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		await request.toArray();
		response.status(503).end('retry');
	});
	await withServer(t, async (_t, destination) => {
		let destinationRequests = 0;
		destination.post('/', (_request, response) => {
			destinationRequests++;
			response.end();
		});
		const body = new Readable({read() {}});
		const destroy = t.mock.method(body, 'destroy');
		let errorHooks = 0;
		const result = Promise.withResolvers<void>();
		const request = got.stream.post('', {
			allowAbsoluteUrls: false, body: 'source payload',
			retry: {
				limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0,
			},
			hooks: {
				beforeError: [error => {
					errorHooks++;
					return error;
				}],
			},
		});
		request.on('error', result.reject);
		request.on('retry', (_retryCount, _error, createRetryStream) => {
			const replacement = createRetryStream({url: destination.url, body});
			void assert.rejects(replacement.toArray(), {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}).then(result.resolve).catch(result.reject);
		});
		request.resume();
		await result.promise;
		assert.strictEqual(body.destroyed, true);
		assert.strictEqual(destroy.mock.callCount(), 1);
		assert.strictEqual(errorHooks, 1);
		assert.strictEqual(destinationRequests, 0);
	});
});

test('a retry stream observes replacement upload errors before its deferred flush', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		await request.toArray();
		response.status(503).end('retry');
	});
	const body = new PassThrough();
	t.after(() => {
		body.destroy();
	});
	const cause = new Error('Replacement upload failed before flushing');
	const result = Promise.withResolvers<void>();
	const request = got.stream.post('', {
		body: 'source payload', retry: {
			limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0,
		},
	});
	request.on('error', result.reject);
	request.on('retry', (_retryCount, _error, createRetryStream) => {
		const replacement = createRetryStream({body});
		void assert.rejects(replacement.toArray(), error => error instanceof UploadError && error.cause === cause).then(result.resolve).catch(result.reject);
		assert.doesNotThrow(() => {
			body.emit('error', cause);
		});
	});
	request.resume();
	await result.promise;
	assert.strictEqual(body.destroyed, true);
});

test('a rejected retry update owns a replacement body error before deferred validation handling', withServer, async (t, server) => {
	server.post('/', async (request, response) => {
		await request.toArray();
		response.status(503).end('retry');
	});
	await withServer(t, async (_t, destination) => {
		const script = `
			import assert from 'node:assert/strict';
			import {Readable} from 'node:stream';
			import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
			let destroys = 0;
			let callbackCompleted = false;
			const body = new Readable({read() {}, destroy(error, callback) {destroys++; callback(error);}});
			const result = Promise.withResolvers();
			const request = got.stream.post('', {
				prefixUrl: process.argv[1], allowAbsoluteUrls: false, body: 'source payload',
				retry: {limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0},
			});
			request.on('error', error => {throw new Error('The failed attempt received a replacement body error', {cause: error});});
			request.on('retry', (_retryCount, _error, createRetryStream) => {
				const replacement = createRetryStream({url: process.argv[2], body});
				assert.rejects(replacement.toArray(), {message: 'The \`url\` option must be relative when \`allowAbsoluteUrls\` is false and \`prefixUrl\` is set'}).then(result.resolve).catch(result.reject);
				body.emit('error', new Error('Replacement body failed after the update was rejected'));
				callbackCompleted = true;
			});
			request.resume();
			await result.promise;
			assert.strictEqual(body.destroyed, true);
			assert.strictEqual(destroys, 1);
			assert.strictEqual(callbackCompleted, true);
		`;
		await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url, destination.url], {timeout: 10_000});
	});
});
