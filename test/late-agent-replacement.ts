import assert from 'node:assert/strict';
import getStream from 'get-stream';
import type {BeforeRequestHook} from '../source/index.js';
import test from './helpers/test.js';
import {withHttpsServer} from './helpers/with-server.js';

for (const agent of [{}, {http2: false as const}, {http: false as const}]) {
	for (const stage of ['beforeRequest', 'handler'] as const) {
		for (const api of ['promise', 'stream'] as const) {
			test(`HTTP/2 ${api} fallback accepts ${JSON.stringify(agent)} from ${stage}`, withHttpsServer(), async (_t, server, got) => {
				server.get('/', (_request, response) => {
					response.end('native fallback');
				});
				const client = stage === 'handler'
					? got.extend({
						handlers: [(options, next) => {
							options.agent = agent;
							return next(options);
						}],
					})
					: got;
				const beforeRequest: BeforeRequestHook[] = stage === 'beforeRequest'
					? [options => {
						options.agent = agent;
					}]
					: [];
				const options = {http2: true, retry: {limit: 0}, hooks: {beforeRequest}};

				if (api === 'stream') {
					const request = client.stream('', options);
					assert.strictEqual(await getStream(request), 'native fallback');
					assert.strictEqual(request.response?.httpVersion, '1.1');
				} else {
					const response = await client('', options);
					assert.strictEqual(response.body, 'native fallback');
					assert.strictEqual(response.httpVersion, '1.1');
				}
			});
		}
	}
}
