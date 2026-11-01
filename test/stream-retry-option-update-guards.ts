import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('a retry stream can replay unchanged same-origin options without an update', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		requests++;
		const body = Buffer.concat(await request.toArray()).toString();
		response.status(requests === 1 ? 503 : 200).end(body);
	});
	const result = Promise.withResolvers<string>();
	const request = got.stream.post('', {
		body: 'replayed payload', retry: {
			limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0,
		},
	});
	request.on('error', result.reject);
	request.on('retry', (_retryCount, _error, createRetryStream) => {
		const replacement = createRetryStream();
		void replacement.toArray().then((chunks: Uint8Array[]) => {
			result.resolve(Buffer.concat(chunks).toString());
		}).catch(result.reject);
	});
	request.resume();
	assert.strictEqual(await result.promise, 'replayed payload');
	assert.strictEqual(requests, 2);
});
