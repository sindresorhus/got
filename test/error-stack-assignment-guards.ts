import assert from 'node:assert/strict';
import got, {RequestError} from '../source/index.js';
import test from './helpers/test.js';

test('an error stack follows header changes until the caller assigns a replacement', _t => {
	const cause = new Error('Original cause');
	const error = new RequestError('Original message', cause, got.defaults.options);
	assert.strictEqual(error.stack.split('\n', 1)[0], 'RequestError: Original message');

	error.name = 'ReportedError';
	error.message = 'Safe message';
	assert.strictEqual(error.stack.split('\n', 1)[0], 'ReportedError: Safe message');
	assert.strictEqual(error.stack.includes(cause.stack!.split('\n', 2)[1]!), true);

	error.stack = 'Redacted stack';
	error.name = 'ChangedError';
	error.message = 'Changed message';
	assert.strictEqual(error.stack, 'Redacted stack');
	assert.strictEqual(error.cause, cause);
});

test('replacing an assigned stack, including an empty stack, works like a native Error', _t => {
	const nativeError = new Error('Native message');
	const error = new RequestError('Wrapped message', new Error('Cause'), got.defaults.options);

	for (const stack of ['First stack', '', 'Replacement stack', '']) {
		nativeError.stack = stack;
		error.stack = stack;
		assert.strictEqual(error.stack, nativeError.stack);
		assert.strictEqual(Object.keys(error).includes('stack'), false);
	}
});
