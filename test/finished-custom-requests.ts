import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import getStream from 'get-stream';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const useCache of [false, true]) {
	test(`an asynchronous custom request can finish its native upload before adoption ${useCache ? 'with' : 'without'} caching`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('finished upload');
		});
		let uploadCompletions = 0;
		const response = await got('', {
			cache: useCache ? new Map() : false,
			retry: {limit: 0},
			async request(url, options, callback) {
				const request = http.get(url, options, callback);
				request.on('upload-complete', () => {
					uploadCompletions++;
				});
				await once(request, 'finish');
				assert.strictEqual(request.writableFinished, true);
				return request;
			},
		});
		assert.strictEqual(response.body, 'finished upload');
		assert.strictEqual(response.request.writableFinished, true);
		assert.strictEqual(uploadCompletions, 1);
	});
}

test('the streaming API can finish its writable side after a custom transport sent the upload', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	const stream = got.stream.post('', {
		retry: {limit: 0},
		async request(url, options, callback) {
			const request = http.request(url, options, callback);
			request.end('manual transport body');
			await once(request, 'finish');
			return request;
		},
	});
	let finishes = 0;
	stream.on('finish', () => {
		finishes++;
	});
	stream.end();
	assert.strictEqual(await getStream(stream), 'manual transport body');
	assert.strictEqual(finishes, 1);
});

test('a completed native upload still reports a connection failure before the response', withServer, async (_t, server, got) => {
	server.get('/', (request, _response) => {
		request.socket.destroy();
	});
	await assert.rejects(got('', {
		retry: {limit: 0},
		async request(url, options, callback) {
			const request = http.get(url, options, callback);
			await once(request, 'finish');
			return request;
		},
	}), {code: 'ECONNRESET'});
});
