import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {
	AbortError,
	CacheError,
	RequestError,
	RetryError,
	type Request,
} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const cancellation of ['abort', 'destroy'] as const) {
	for (const update of ['body', 'init', 'same-owner'] as const) {
		test(`a late afterResponse retry rejects ${update} updates after ${cancellation}`, withServer, async (_t, server, got) => {
			let requests = 0;
			server.all('/', (request, response) => {
				requests++;
				request.resume();
				response.end('original response');
			});
			const controller = new AbortController();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const hookEnded = Promise.withResolvers<void>();
			const reason = new Error('The caller stopped the request');
			const replacement = new Readable({read() {}});
			let initializedBody: Readable | undefined;
			let initCalls = 0;
			let laterHooks = 0;
			let responseEvents = 0;
			let request: Request | undefined;
			let callbackError: unknown;
			const pending = got('', {
				signal: controller.signal,
				retry: {limit: 0},
				hooks: {
					init: [(plain, options) => {
						if (plain.context?.lateRetry === true) {
							initCalls++;
							if (update === 'init') {
								initializedBody = new Readable({read() {}});
								options.body = initializedBody;
							}
						}
					}],
					afterResponse: [async (response, retryWithMergedOptions) => {
						request = response.request;
						entered.resolve();
						await release.promise;
						try {
							// Await the retry signal before recording completion of the cancelled hook.
							return await retryWithMergedOptions(update === 'same-owner'
								? request.options
								: {
									method: 'POST',
									context: {lateRetry: true},
									...(update === 'body' && {body: replacement}),
								});
						} catch (error) {
							callbackError = error;
							return response;
						} finally {
							hookEnded.resolve();
						}
					}, response => {
						laterHooks++;
						return response;
					}],
				},
			}).on('response', () => {
				responseEvents++;
			}).catch((error: unknown) => error);
			try {
				await Promise.race([entered.promise, pending.then(() => assert.fail('The response hook must wait before cancellation'))]);
				assert.ok(request);
				const hooksBeforeCancellation = request.options.hooks.afterResponse;
				if (cancellation === 'abort') {
					controller.abort(reason);
				} else {
					request.destroy(reason);
				}

				const error = await pending;
				assert.ok(error instanceof RequestError);
				assert.strictEqual(error instanceof AbortError, cancellation === 'abort');
				assert.strictEqual(error.cause, reason);
				assert.strictEqual(request.destroyed, true);
				release.resolve();
				await hookEnded.promise;
				await setImmediate();
				assert.ok(callbackError instanceof RetryError);
				assert.strictEqual(initCalls, 0);
				assert.strictEqual(initializedBody, undefined);
				assert.strictEqual(request.options.body, undefined);
				assert.strictEqual(request.options.method, 'GET');
				assert.strictEqual(request.options.context.lateRetry, undefined);
				assert.strictEqual(request.options.hooks.afterResponse, hooksBeforeCancellation);
				// An inactive callback never accepts the fresh body, so the caller still owns it.
				assert.strictEqual(replacement.destroyed, false);
				assert.strictEqual(replacement.readableDidRead, false);
				assert.strictEqual(laterHooks, 0);
				assert.strictEqual(responseEvents, 0);
				assert.strictEqual(requests, 1);
			} finally {
				release.resolve();
				replacement.destroy();
				initializedBody?.destroy();
				request?.destroy();
				await pending;
			}
		});
	}
}

test('a claimed cache failure rejects afterResponse retry updates while error hooks still own teardown', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('cacheable response');
	});
	const write = Promise.withResolvers<void>();
	const errorEntered = Promise.withResolvers<void>();
	const finishError = Promise.withResolvers<void>();
	const hookEnded = Promise.withResolvers<void>();
	const replacement = new Readable({read() {}});
	const cause = new Error('Cache storage failed');
	const cache = new Map();
	Object.defineProperty(cache, 'set', {
		async value() {
			await write.promise;
			throw cause;
		},
	});
	let request: Request | undefined;
	let callbackError: unknown;
	let claimedError: unknown;
	let initCalls = 0;
	const pending = got('', {
		cache,
		retry: {limit: 0},
		hooks: {
			init: [plain => {
				if (plain.context?.lateRetry === true) {
					initCalls++;
				}
			}],
			afterResponse: [async (response, retryWithMergedOptions) => {
				request = response.request;
				write.resolve();
				await errorEntered.promise;
				try {
					// Catch the rejected retry signal while the original cache failure retains ownership.
					return await retryWithMergedOptions({method: 'POST', body: replacement, context: {lateRetry: true}});
				} catch (error) {
					callbackError = error;
					return response;
				} finally {
					hookEnded.resolve();
				}
			}],
			beforeError: [async error => {
				claimedError = error;
				errorEntered.resolve();
				await finishError.promise;
				return error;
			}],
		},
	}).catch((error: unknown) => error);
	try {
		await Promise.race([hookEnded.promise, pending.then(() => assert.fail('The error hook must retain teardown ownership'))]);
		assert.ok(request);
		assert.strictEqual(request.destroyed, false);
		assert.ok(claimedError instanceof CacheError);
		assert.ok(callbackError instanceof RetryError);
		assert.strictEqual(initCalls, 0);
		assert.strictEqual(request.options.body, undefined);
		assert.strictEqual(request.options.method, 'GET');
		assert.strictEqual(request.options.context.lateRetry, undefined);
		assert.strictEqual(replacement.destroyed, false);
		finishError.resolve();
		assert.strictEqual(await pending, claimedError);
		assert.strictEqual(requests, 1);
	} finally {
		write.resolve();
		finishError.resolve();
		replacement.destroy();
		await pending;
	}
});
