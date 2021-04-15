import test from 'ava';
import WeakableMap from '../source/core/utils/weakable-map.js';

test('works as expected', t => {
	const weakable = new WeakableMap();

	weakable.set('hello', 'world');

	t.true(weakable.has('hello'));
	t.false(weakable.has('foobar'));
	t.is(weakable.get('hello'), 'world');
	t.is(weakable.get('foobar'), undefined);

	const object = {};
	const anotherObject = {};
	weakable.set(object, 'world');

	t.true(weakable.has(object));
	t.false(weakable.has(anotherObject));
	t.is(weakable.get(object), 'world');
	t.is(weakable.get(anotherObject), undefined);
});
