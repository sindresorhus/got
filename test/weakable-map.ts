import assert from 'node:assert/strict';
import WeakableMap from '../source/core/utils/weakable-map.js';
import test from './helpers/test.js';

test('works as expected', _t => {
	const weakable = new WeakableMap();

	weakable.set('hello', 'world');

	assert.strictEqual(weakable.has('hello'), true);
	assert.strictEqual(weakable.has('foobar'), false);
	assert.strictEqual(weakable.get('hello'), 'world');
	assert.strictEqual(weakable.get('foobar'), undefined);

	const object = {};
	const anotherObject = {};
	weakable.set(object, 'world');

	assert.strictEqual(weakable.has(object), true);
	assert.strictEqual(weakable.has(anotherObject), false);
	assert.strictEqual(weakable.get(object), 'world');
	assert.strictEqual(weakable.get(anotherObject), undefined);
});
