import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {CacheError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const asynchronous of [false, true]) {
	test(`an active request owns a ${asynchronous ? 'rejected' : 'thrown'} cache write failure`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('cache-control', 'public, max-age=60');
			response.end('cacheable response');
		});
		const cause = Object.assign(new Error('Cache write failed'), {code: 'EACCES'});
		const writeAttempt = Promise.withResolvers<void>();
		let writes = 0;
		const failWrite = () => {
			writes++;
			writeAttempt.resolve();
			throw cause;
		};

		const cache = new Map();
		Object.defineProperty(cache, 'set', {
			value: asynchronous
				? async () => {
					await setImmediate();
					failWrite();
				}
				: failWrite,
		});
		const beforeErrors: Error[] = [];
		const error: unknown = await got('', {
			cache,
			retry: {limit: 0},
			hooks: {
				afterResponse: [async response => {
					await writeAttempt.promise;
					await setImmediate();
					return response;
				}],
				beforeError: [error => {
					beforeErrors.push(error);
					return error;
				}],
			},
		}).catch((error: unknown) => error);
		assert.strictEqual(writes, 1);
		assert.ok(error instanceof CacheError);
		assert.strictEqual(error.code, 'ERR_CACHE_ACCESS');
		assert.ok(error.cause instanceof Error);
		assert.strictEqual(error.cause.message, cause.message);
		assert.strictEqual(Reflect.get(error.cause, 'code'), cause.code);
		assert.deepStrictEqual(beforeErrors, [error]);
	});
}

test('cache write failures run the complete beforeError transformation chain', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('cacheable response');
	});
	const cache = new Map();
	let writes = 0;
	Object.defineProperty(cache, 'set', {
		value() {
			writes++;
			throw new Error('Storage failed');
		},
	});
	const transformed = new Error('Transformed cache failure');
	const visited: string[] = [];
	await assert.rejects(got('', {
		cache,
		retry: {limit: 0},
		hooks: {
			beforeError: [error => {
				assert.ok(error instanceof CacheError);
				visited.push('first');
				return transformed;
			}, error => {
				assert.strictEqual(error, transformed);
				visited.push('second');
				return error;
			}],
		},
	}), error => error === transformed);
	assert.strictEqual(writes, 1);
	assert.deepStrictEqual(visited, ['first', 'second']);
});

test('an active cache write failure can retry through the configured cache error rule', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(`response ${requests}`);
	});
	const cache = new Map();
	const originalSet = cache.set.bind(cache);
	let writes = 0;
	Object.defineProperty(cache, 'set', {
		value(key: string, value: unknown) {
			writes++;
			if (writes === 1) {
				throw new Error('Temporary storage failure');
			}

			return originalSet(key, value);
		},
	});
	const beforeRetries: Error[] = [];
	const response = await got('', {
		cache,
		retry: {
			limit: 1,
			errorCodes: ['ERR_CACHE_ACCESS'],
			calculateDelay: ({computedValue}) => computedValue === 0 ? 0 : 1,
		},
		hooks: {
			beforeRetry: [error => {
				beforeRetries.push(error);
			}],
		},
	});
	assert.strictEqual(response.body, 'response 2');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(requests, 2);
	assert.strictEqual(writes, 2);
	assert.strictEqual(beforeRetries.length, 1);
	assert.ok(beforeRetries[0] instanceof CacheError);
	assert.strictEqual(cache.size, 1);
});

test('a claimed cache failure wins over an afterResponse hook while beforeError is pending', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('cacheable response');
	});
	const write = Promise.withResolvers<void>();
	const errorStarted = Promise.withResolvers<void>();
	const finishError = Promise.withResolvers<void>();
	t.after(() => {
		finishError.resolve();
	});
	const cache = new Map();
	Object.defineProperty(cache, 'set', {
		async value() {
			await write.promise;
			throw new Error('Cache failure during response processing');
		},
	});
	let settled = false;
	const pending = got('', {
		cache,
		retry: {limit: 0},
		hooks: {
			afterResponse: [async response => {
				write.resolve();
				await errorStarted.promise;
				return response;
			}],
			beforeError: [async error => {
				errorStarted.resolve();
				await finishError.promise;
				return error;
			}],
		},
	});
	void pending.then(() => {
		settled = true;
	}).catch(() => {
		settled = true;
	});
	await errorStarted.promise;
	await setImmediate();
	assert.strictEqual(settled, false);
	finishError.resolve();
	await assert.rejects(pending, CacheError);
});

test('a late cache persistence failure does not error an already completed stream', withServer, async (_t, server, got) => {
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
			throw new Error('Storage failed after stream completion');
		},
	});
	const stream = got.stream('', {cache, retry: {limit: 0}});
	const errors: Error[] = [];
	stream.on('error', error => {
		errors.push(error);
	});
	let body = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		body += chunk;
	});
	await once(stream, 'end');
	assert.strictEqual(body, 'completed response');
	await started.promise;
	assert.strictEqual(stream.readableEnded, true);
	assert.strictEqual(stream.writableFinished, true);
	assert.strictEqual(stream.destroyed, false);
	release.resolve();
	await setImmediate();
	await setImmediate();
	assert.strictEqual(errors.length, 0);
	assert.strictEqual(stream.destroyed, false);
});
