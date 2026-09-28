import assert from 'node:assert/strict';

/**
Asserts that a promise rejects and returns the rejection reason.

AVAs `t.throwsAsync` resolved with the error, and much of this suite inspects it afterwards.
`assert.rejects` resolves with `undefined`, so the tests that need the error use this instead.

The type parameter stands in for `throwsAsync`'s own: it types the resolved reason, which is what
keeps the `expectTypeOf` checks over a rejection meaningful rather than checked against `any`.
*/
export async function rejects<Reason = any>(promise: Promise<unknown>, expectation?: unknown): Promise<Reason> {
	let rejection: any;
	let didReject = false;

	try {
		await promise;
	} catch (error) {
		didReject = true;
		rejection = error;
	}

	if (!didReject) {
		assert.fail('Expected the promise to reject, but it resolved');
	}

	// The promise already rejected, so the expectation is re-checked against the captured reason.
	// Handing that reason to `assert.throws` rather than to `assert.rejects` is deliberate: an
	// `async () => rejection` wrapper *resolves* with the reason, which `assert.rejects` reports
	// as a missing rejection.
	assert.throws(() => {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- Re-raising the captured reason is the re-check.
		throw rejection;
	}, expectation as any);

	return rejection as Reason;
}

export default rejects;
