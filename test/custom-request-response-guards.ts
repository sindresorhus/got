import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const useCache of [false, true]) {
	test(`an asynchronous custom request can return its response directly ${useCache ? 'with' : 'without'} a cache configured`, withServer, async (_t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.setHeader('cache-control', 'public, max-age=60');
			response.end('direct response');
		});
		const cache = useCache ? new Map() : false;
		const client = got.extend({
			cache,
			async request(url, options) {
				const request = http.get(url, options);
				const [response] = await once(request, 'response');
				return response;
			},
		});
		const responses = [await client(''), await client('')];
		for (const response of responses) {
			assert.strictEqual(response.body, 'direct response');
			assert.strictEqual(response.isFromCache, false);
		}

		assert.strictEqual(requests, 2);
		if (cache) {
			assert.strictEqual(cache.size, 0);
		}
	});
}
