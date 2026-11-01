import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import getStream from 'get-stream';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const useCache of [false, true]) {
	test(`a finished custom transport does not resend its configured body ${useCache ? 'with' : 'without'} caching`, withServer, async (_t, server, got) => {
		const payload = 'body already sent by the custom transport';
		server.post('/', async (request, response) => {
			response.end(await getStream(request));
		});
		const response = await got.post('', {
			body: payload,
			cache: useCache ? new Map() : false,
			retry: {limit: 0},
			async request(url, options, callback) {
				const request = http.request(url, options, callback);
				request.end(payload);
				await once(request, 'finish');
				return request;
			},
		});
		assert.strictEqual(response.body, payload);
		assert.strictEqual(response.request.writableFinished, true);
	});
}
