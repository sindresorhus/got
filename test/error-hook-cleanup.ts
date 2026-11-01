import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const asynchronous of [false, true]) {
	for (const outcome of ['fulfilled', 'rejected']) {
		test(`clean request destruction preserves a ${outcome} error hook with asynchronous completion ${asynchronous}`, withServer, async (_t, server, got) => {
			server.get('/', (_request, response) => {
				response.status(500).end('failure');
			});
			const cleaned = Promise.withResolvers<void>();
			const hookFailure = new Error('The cleanup hook failed');
			const replacement = new TypeError('The later hook replaced the error');
			const calls: string[] = [];
			const events: Error[] = [];
			let settled = false;
			let closes = 0;
			const result = got('', {
				retry: {limit: 0},
				hooks: {
					beforeError: [error => {
						assert.ok(error.request);
						error.request.on('error', (error: Error) => {
							events.push(error);
						});
						error.request.once('close', () => {
							closes++;
						});
						error.request.destroy();
						calls.push('cleanup');
						cleaned.resolve();
						const finish = () => {
							if (outcome === 'rejected') {
								throw hookFailure;
							}

							return error;
						};

						return asynchronous ? setImmediate().then(finish) : finish();
					}, error => {
						assert.ok(error instanceof RequestError);
						calls.push('replacement');
						return replacement;
					}],
				},
			}).then(response => {
				settled = true;
				return response;
			}, (error: unknown) => {
				settled = true;
				return error;
			});
			await cleaned.promise;
			await setImmediate();
			assert.strictEqual(settled, true, 'Cleanup must not leave the request promise pending');
			const error = await result;
			if (outcome === 'fulfilled') {
				assert.strictEqual(error, replacement);
				assert.deepStrictEqual(calls, ['cleanup', 'replacement']);
			} else {
				assert.ok(error instanceof RequestError);
				assert.strictEqual(error.cause, hookFailure);
				assert.deepStrictEqual(calls, ['cleanup']);
			}

			assert.deepStrictEqual(events, [error]);
			assert.strictEqual(closes, 1);
		});
	}
}
