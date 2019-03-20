import {URLSearchParams} from 'url';
import test from 'ava';
import got from '../source';
import {withServer} from './helpers/with-server';

const responseFn = (request, response) => {
	request.resume();
	response.end(JSON.stringify(request.headers));
};

test('merging instances', withServer, async (t, s) => {
	s.get('/', responseFn);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({baseUrl: s.url});
	const merged = got.mergeInstances(instanceA, instanceB);

	const headers = await merged('/').json();
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('works even if no default handler in the end', withServer, async (t, s) => {
	s.get('/', responseFn);

	const instanceA = got.create({
		options: {},
		handler: (options, next) => next(options)
	});

	const instanceB = got.create({
		options: {},
		handler: (options, next) => next(options)
	});

	const merged = got.mergeInstances(instanceA, instanceB);
	await t.notThrows(() => merged(s.url));
});

test('merges default handlers & custom handlers', withServer, async (t, s) => {
	s.get('/', responseFn);
	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.create({
		options: {},
		handler: (options, next) => {
			options.headers.cat = 'meow';
			return next(options);
		}
	});
	const merged = got.mergeInstances(instanceA, instanceB);

	const headers = await merged(s.url).json();
	t.is(headers.unicorn, 'rainbow');
	t.is(headers.cat, 'meow');
});

test('merging one group & one instance', withServer, async (t, s) => {
	s.get('/', responseFn);

	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const merged = got.mergeInstances(instanceA, instanceB, instanceC);
	const doubleMerged = got.mergeInstances(merged, instanceD);

	const headers = await doubleMerged(s.url).json();
	t.is(headers.dog, 'woof');
	t.is(headers.cat, 'meow');
	t.is(headers.bird, 'tweet');
	t.is(headers.mouse, 'squeek');
});

test('merging two groups of merged instances', withServer, async (t, s) => {
	s.get('/', responseFn);

	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const groupA = got.mergeInstances(instanceA, instanceB);
	const groupB = got.mergeInstances(instanceC, instanceD);

	const merged = got.mergeInstances(groupA, groupB);

	const headers = await merged(s.url).json();
	t.is(headers.dog, 'woof');
	t.is(headers.cat, 'meow');
	t.is(headers.bird, 'tweet');
	t.is(headers.mouse, 'squeek');
});

test('hooks are merged', t => {
	const getBeforeRequestHooks = instance => instance.defaults.options.hooks.beforeRequest;

	const instanceA = got.extend({hooks: {
		beforeRequest: [
			options => {
				options.headers.dog = 'woof';
			}
		]
	}});
	const instanceB = got.extend({hooks: {
		beforeRequest: [
			options => {
				options.headers.cat = 'meow';
			}
		]
	}});

	const merged = got.mergeInstances(instanceA, instanceB);
	t.deepEqual(getBeforeRequestHooks(merged), getBeforeRequestHooks(instanceA).concat(getBeforeRequestHooks(instanceB)));
});

test('hooks are passed by though other instances don\'t have them', t => {
	const instanceA = got.extend({hooks: {
		beforeRequest: [
			options => {
				options.headers.dog = 'woof';
			}
		]
	}});
	const instanceB = got.create({
		options: {}
	});
	const instanceC = got.create({
		options: {hooks: {}}
	});

	const merged = got.mergeInstances(instanceA, instanceB, instanceC);
	t.deepEqual(merged.defaults.options.hooks.beforeRequest, instanceA.defaults.options.hooks.beforeRequest);
});

test('URLSearchParams instances are merged', t => {
	const instanceA = got.extend({
		searchParams: new URLSearchParams({a: '1'})
	});

	const instanceB = got.extend({
		searchParams: new URLSearchParams({b: '2'})
	});

	const merged = got.mergeInstances(instanceA, instanceB);
	t.is(merged.defaults.options.searchParams.get('a'), '1');
	t.is(merged.defaults.options.searchParams.get('b'), '2');
});
