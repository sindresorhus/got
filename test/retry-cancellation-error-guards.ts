import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const phase of ['calculateDelay', 'beforeRetry'] as const) {
	test(`an active rejected ${phase} callback still owns its terminal error`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.status(503).end('retry later');
		});
		const cause = new Error('Active retry callback failed');
		const fail = async () => {
			await setImmediate();
			throw cause;
		};

		const beforeErrors: Error[] = [];
		const error: unknown = await got('', {
			retry: {limit: 1, calculateDelay: phase === 'calculateDelay' ? fail : () => 1},
			hooks: {
				beforeRetry: phase === 'beforeRetry' ? [fail] : [],
				beforeError: [error => {
					beforeErrors.push(error);
					return error;
				}],
			},
		}).catch((error: unknown) => error);
		assert.ok(error instanceof RequestError);
		assert.strictEqual(error.cause, cause);
		assert.deepStrictEqual(beforeErrors, [error]);
	});
}
