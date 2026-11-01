import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {AbortError, type RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const {api, outcome} of [
	{api: 'promise', outcome: 'fulfilled'},
	{api: 'stream', outcome: 'fulfilled'},
	{api: 'promise', outcome: 'rejected'},
]) {
	test(`cancellation stops a ${outcome} continuation of a beforeError hook in the ${api} API`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.status(500).end('failure');
		});
		const controller = new AbortController();
		const reason = new Error('Stop the pending error hook');
		const hookFailure = new Error('The cancelled error hook rejected');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const calls: string[] = [];
		const events: Error[] = [];
		let closes = 0;
		const options = {
			signal: controller.signal,
			retry: {limit: 0},
			hooks: {
				beforeError: [async (error: RequestError) => {
					assert.ok(error.request);
					error.request.on('error', (error: Error) => {
						events.push(error);
					});
					error.request.once('close', () => {
						closes++;
					});
					calls.push('first');
					entered.resolve();
					await release.promise;
					if (outcome === 'rejected') {
						throw hookFailure;
					}

					return error;
				}, (error: RequestError) => {
					calls.push('second');
					return error;
				}],
			},
		};
		const result = api === 'promise'
			? got('', options).catch((error: unknown) => error)
			: got.stream('', options).toArray().catch((error: unknown) => error);
		try {
			await entered.promise;
			controller.abort(reason);
			const error = await result;
			assert.ok(error instanceof AbortError);
			assert.strictEqual(error.cause, reason);
		} finally {
			release.resolve();
		}

		await setImmediate();
		assert.deepStrictEqual(calls, ['first']);
		assert.deepStrictEqual(events, [await result]);
		assert.strictEqual(closes, 1);
	});
}
