import assert from 'node:assert/strict';
import {AbortError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('cancelling from final download progress still cancels an active stream', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('complete response');
	});
	const controller = new AbortController();
	const cause = new Error('Cancel before response completion');
	const request = got.stream('', {signal: controller.signal});
	request.on('downloadProgress', progress => {
		if (progress.percent === 1) {
			controller.abort(cause);
		}
	});
	await assert.rejects(request.toArray(), error => error instanceof AbortError && error.cause === cause);
});

test('cancellation interrupts an asynchronous error hook after final download progress fails', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('complete response');
	});
	const controller = new AbortController();
	const cause = new Error('Cancel while the observer error hook is pending');
	const observerError = new Error('Final progress observer failed');
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const request = got.stream('', {
		signal: controller.signal,
		hooks: {
			beforeError: [async error => {
				assert.strictEqual(error.cause, observerError);
				entered.resolve();
				await release.promise;
				return error;
			}],
		},
	});
	request.on('downloadProgress', progress => {
		if (progress.percent === 1) {
			throw observerError;
		}
	});
	const result = request.toArray().catch((error: unknown) => error);
	try {
		await entered.promise;
		controller.abort(cause);
		assert.strictEqual(request.destroyed, true);
		assert.ok(await result instanceof AbortError);
	} finally {
		release.resolve();
	}

	const error = await result;
	assert.ok(error instanceof AbortError);
	assert.strictEqual(error.cause, cause);
});
