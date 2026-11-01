import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('a late cache persistence failure does not change an already completed request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('completed response');
	});
	const cache = new Map();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	Object.defineProperty(cache, 'set', {
		async value() {
			started.resolve();
			await release.promise;
			throw new Error('Storage failed after request completion');
		},
	});
	let beforeErrors = 0;
	const response = await got('', {
		cache,
		retry: {limit: 0},
		hooks: {
			beforeError: [error => {
				beforeErrors++;
				return error;
			}],
		},
	});
	await started.promise;
	assert.strictEqual(response.request.destroyed, true);
	release.resolve();
	await setImmediate();
	assert.strictEqual(response.body, 'completed response');
	assert.strictEqual(beforeErrors, 0);
	assert.strictEqual(cache.size, 0);
});
