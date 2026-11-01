import assert from 'node:assert/strict';
import {once} from 'node:events';
import got, {RequestError} from '../source/index.js';
import test from './helpers/test.js';

test('a beforeError result does not change how another request owns the same error', async _t => {
	const cause = new Error('Shared cancellation reason');
	await assert.rejects(got('http://example.invalid/', {
		retry: {limit: 0},
		request() {
			throw new Error('Initial request failure');
		},
		hooks: {beforeError: [() => cause]},
	}), error => error === cause);
	const stream = got.stream('http://example.invalid/', {
		hooks: {beforeRequest: [async () => new Promise(() => {})]},
	});
	const failed = once(stream, 'error');
	stream.destroy(cause);
	const [error] = await failed;
	assert.ok(error instanceof RequestError);
	assert.strictEqual(error.cause, cause);
	assert.strictEqual(error.request, stream);
	assert.strictEqual(stream.errored, cause);
});
