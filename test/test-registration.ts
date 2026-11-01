import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {expectTypeOf} from 'expect-type';
import test from './helpers/test.js';

test('test bodies accept per-test options with an inferred native context', {timeout: 5000}, t => {
	expectTypeOf(t).toEqualTypeOf<TestContext>();
	assert.strictEqual(t.name, 'test bodies accept per-test options with an inferred native context');
	assert.strictEqual(t.signal.aborted, false);
});

test.serial('serial test bodies accept per-test options and await native subtests', {timeout: 5000}, async t => {
	expectTypeOf(t).toEqualTypeOf<TestContext>();
	await t.test('native subtest', context => {
		expectTypeOf(context).toEqualTypeOf<TestContext>();
		assert.strictEqual(context.name, 'native subtest');
	});
});
