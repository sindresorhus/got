import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {AbortError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const phase of ['calculateDelay', 'beforeRetry'] as const) {
	test(`a rejected ${phase} callback does not run error hooks after cancellation`, withServer, async (t, server, got) => {
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.status(503).end('retry later');
		});
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<number>();
		const controller = new AbortController();
		t.after(() => {
			controller.abort();
			finish.resolve(1);
		});
		const pause = async () => {
			started.resolve();
			return finish.promise;
		};

		const beforeErrors: Error[] = [];
		let beforeRetries = 0;
		const pending = got('', {
			signal: controller.signal,
			retry: {limit: 1, calculateDelay: phase === 'calculateDelay' ? pause : () => 1},
			hooks: {
				beforeRetry: [async () => {
					beforeRetries++;
					if (phase === 'beforeRetry') {
						await pause();
					}
				}],
				beforeError: [error => {
					beforeErrors.push(error);
					return error;
				}],
			},
		});
		const cancellation = new Error('Retry cancelled by the caller');
		const rejected = assert.rejects(pending, error => error instanceof AbortError && error.cause === cancellation);
		await started.promise;
		controller.abort(cancellation);
		await rejected;
		finish.reject(new Error('Stale retry callback failed'));
		await setImmediate();
		assert.deepStrictEqual(beforeErrors, []);
		assert.strictEqual(beforeRetries, phase === 'beforeRetry' ? 1 : 0);
		assert.strictEqual(requests, 1);
	});
}
