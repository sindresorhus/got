import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import process from 'node:process';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const cacheable of [false, true]) {
	test(`cached asynchronous transport failures own a ${cacheable ? 'cacheable' : 'non-cacheable'} response received before rejection`, withServer, async (_t, server) => {
		server.get('/', (_request, response) => {
			response.setHeader('cache-control', cacheable ? 'public, max-age=60' : 'no-store');
			response.write('unfinished response');
		});
		const script = `
			import assert from 'node:assert/strict';
			import http from 'node:http';
			import {once} from 'node:events';
			import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
			const cause = new Error('Transport failed after receiving headers');
			const cache = new Map();
			let nativeResponse;
			let responseClosed;
			await assert.rejects(got(process.argv[1], {
				cache,
				retry: {limit: 0},
				async request(url, options, callback) {
					const request = http.get(url, options, callback);
					[nativeResponse] = await once(request, 'response');
					responseClosed = new Promise(resolve => {nativeResponse.once('close', resolve);});
					throw cause;
				},
			}), error => {
				assert.strictEqual(error.cause, cause);
				return true;
			});
			await responseClosed;
			assert.strictEqual(nativeResponse.destroyed, true);
			assert.strictEqual(nativeResponse.req.destroyed, true);
			assert.strictEqual(cache.size, 0);
		`;
		await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url], {timeout: 15_000});
	});
}
