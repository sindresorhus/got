import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {AbortError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('a rejected error hook continuation preserves the sole cancellation error in stream mode', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.status(500).end('failure');
	});
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const events: Error[] = [];
	let laterHooks = 0;
	const request = got.stream('', {
		signal: controller.signal,
		retry: {limit: 0},
		hooks: {
			beforeError: [async error => {
				assert.ok(error.request);
				error.request.on('error', (error: Error) => {
					events.push(error);
				});
				entered.resolve();
				await release.promise;
				throw new Error('The cancelled hook rejected');
			}, error => {
				laterHooks++;
				return error;
			}],
		},
	});
	const result = request.toArray().catch((error: unknown) => error);
	try {
		await entered.promise;
		controller.abort();
		assert.ok(await result instanceof AbortError);
	} finally {
		release.resolve();
	}

	await setImmediate();
	assert.strictEqual(laterHooks, 0);
	assert.deepStrictEqual(events, [await result]);
});

test('retry rollback still runs every error hook after request destruction', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.status(500).end('failure');
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	const cause = new Error('Retry handoff failed');
	const calls: string[] = [];
	const request = got.stream('', {
		retry: {limit: 1, calculateDelay: () => 1},
		hooks: {
			beforeError: [async error => {
				assert.strictEqual(error.cause, cause);
				assert.strictEqual(error.request?.destroyed, true);
				calls.push('first');
				entered.resolve();
				await release.promise;
				return error;
			}, error => {
				calls.push('second');
				completed.resolve();
				return error;
			}],
		},
	});
	request.on('retry', () => {
		throw cause;
	});
	const result = request.toArray().catch((error: unknown) => error);
	try {
		await entered.promise;
	} finally {
		release.resolve();
	}

	await completed.promise;
	assert.deepStrictEqual(calls, ['first', 'second']);
	assert.ok(await result instanceof Error);
});
