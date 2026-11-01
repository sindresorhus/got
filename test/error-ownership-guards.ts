import assert from 'node:assert/strict';
import {once} from 'node:events';
import got, {RequestError} from '../source/index.js';
import test from './helpers/test.js';

test('concurrent requests can preserve the same custom beforeError result independently', async _t => {
	class CustomError extends Error {}
	const cause = new CustomError('Shared final hook result');
	const client = got.extend({
		retry: {limit: 0},
		request() {
			throw new Error('Native request failed');
		},
		hooks: {beforeError: [async () => cause]},
	});
	const stream = client.stream('http://example.invalid/');
	const streamFailure = once(stream, 'error');
	await Promise.all([
		assert.rejects(client('http://example.invalid/'), error => error === cause),
		streamFailure.then(([error]) => {
			assert.strictEqual(error, cause);
			assert.strictEqual(stream.errored, cause);
		}),
	]);
});

test('public destruction keeps RequestError identity and emits only once', async _t => {
	const stream = got.stream('http://example.invalid/', {
		hooks: {beforeRequest: [async () => new Promise(() => {})]},
	});
	const cause = new Error('Direct cancellation');
	const error = new RequestError(cause.message, cause, stream);
	const errors: Error[] = [];
	stream.on('error', error => {
		errors.push(error);
	});
	const failed = once(stream, 'error');
	assert.strictEqual(stream.destroy(error), stream);
	stream.destroy(new Error('Later cancellation'));
	const [received] = await failed;
	assert.strictEqual(received, error);
	assert.strictEqual(stream.errored, error);
	assert.deepStrictEqual(errors, [error]);
});

test('public errorless destruction remains quiet and does not set an errored state', async _t => {
	const stream = got.stream('http://example.invalid/', {
		hooks: {beforeRequest: [async () => new Promise(() => {})]},
	});
	const closed = once(stream, 'close');
	stream.destroy();
	await closed;
	assert.ifError(stream.errored);
});
