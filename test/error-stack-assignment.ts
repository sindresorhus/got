import assert from 'node:assert/strict';
import got, {RequestError} from '../source/index.js';
import test from './helpers/test.js';

for (const api of ['promise', 'stream']) {
	test(`a ${api} error hook can remove the reconstructed stack like a native Error`, async _t => {
		const nativeError = new Error('Native error');
		nativeError.stack = undefined;
		assert.strictEqual(nativeError.stack, undefined);

		const cause = new Error('Request factory failed');
		let transformed: RequestError | undefined;
		const options = {
			retry: {limit: 0},
			request() {
				throw cause;
			},
			hooks: {
				beforeError: [(error: RequestError) => {
					transformed = error;
					// Error.stack is optional, so callers can clear it before reporting the error.
					const publicError: Error = error;
					publicError.stack = undefined;
					return error;
				}],
			},
		};
		const operation = api === 'promise'
			? got('https://example.com', options)
			: got.stream('https://example.com', options).toArray();
		const error = await operation.catch((error: unknown) => error);
		assert.ok(error instanceof RequestError);
		assert.strictEqual(error, transformed);
		assert.strictEqual(error.cause, cause);
		assert.strictEqual(error.stack, undefined);
	});
}

test('a cleared error stack stays writable and does not regenerate after header changes', _t => {
	const nativeError = new Error('Native message');
	const cause = new Error('Original cause');
	const error = new RequestError('Wrapped message', cause, got.defaults.options);
	const publicError: Error = error;

	for (const stack of [undefined, 'Redacted stack', '', undefined]) {
		nativeError.stack = stack;
		publicError.stack = stack;
		publicError.name = 'ReportedError';
		publicError.message = 'Safe message';
		assert.strictEqual(publicError.stack, nativeError.stack);
		assert.strictEqual(Object.keys(error).includes('stack'), false);
		assert.strictEqual(error.cause, cause);
	}
});
