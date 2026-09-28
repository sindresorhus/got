import assert from 'node:assert/strict';

/**
Asserts that a function throws and returns the error.

`assert.throws` returns `undefined`, while AVAs `t.throws` resolved with the error, so the tests that
inspect it afterwards use this instead.
*/
export function throws(block: () => unknown, expectation?: unknown): any {
	let thrown: any;
	let didThrow = false;

	try {
		block();
	} catch (error) {
		didThrow = true;
		thrown = error;
	}

	if (!didThrow) {
		assert.fail('Expected the function to throw, but it returned');
	}

	// The error is re-checked against the expectation so a mismatch still reports properly.
	assert.throws(() => {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- Re-raising the captured error is the re-check.
		throw thrown;
	}, expectation as any);

	return thrown;
}

export default throws;
