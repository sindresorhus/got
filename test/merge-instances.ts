import {URLSearchParams} from 'url';
import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';

type TestReturn = Record<string, unknown>;

const echoHeaders = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

test('merging instances', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({prefixUrl: server.url});
	const merged = instanceA.extend(instanceB);

	const headers = await merged('').json<TestReturn>();
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('works even if no default handler in the end', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.create({
		options: {}
	});

	const instanceB = got.create({
		options: {}
	});

	const merged = instanceA.extend(instanceB);
	await t.notThrowsAsync(() => merged(server.url));
});

test('merges default handlers & custom handlers', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.create({
		options: {},
		handlers: [
			(options, next) => {
				options.headers.cat = 'meow';
				return next(options);
			}
		]
	});
	const merged = instanceA.extend(instanceB);

	const headers = await merged(server.url).json<TestReturn>();
	t.is(headers.unicorn, 'rainbow');
	t.is(headers.cat, 'meow');
});

test('merging one group & one instance', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const merged = instanceA.extend(instanceB, instanceC);
	const doubleMerged = merged.extend(instanceD);

	const headers = await doubleMerged(server.url).json<TestReturn>();
	t.is(headers.dog, 'woof');
	t.is(headers.cat, 'meow');
	t.is(headers.bird, 'tweet');
	t.is(headers.mouse, 'squeek');
});

test('merging two groups of merged instances', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const groupA = instanceA.extend(instanceB);
	const groupB = instanceC.extend(instanceD);

	const merged = groupA.extend(groupB);

	const headers = await merged(server.url).json<TestReturn>();
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

	const merged = instanceA.extend(instanceB);
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

	const merged = instanceA.extend(instanceB, instanceC);
	t.deepEqual(merged.defaults.options.hooks.beforeRequest, instanceA.defaults.options.hooks.beforeRequest);
});

test('URLSearchParams instances are merged', t => {
	const instanceA = got.extend({
		searchParams: new URLSearchParams({a: '1'})
	});

	const instanceB = got.extend({
		searchParams: new URLSearchParams({b: '2'})
	});

	const merged = instanceA.extend(instanceB);
	// @ts-ignore Manual tests
	t.is(merged.defaults.options.searchParams.get('a'), '1');
	// @ts-ignore Manual tests
	t.is(merged.defaults.options.searchParams.get('b'), '2');
});

// TODO: remove this before Got v11
test('`got.mergeInstances()` works', t => {
	const instance = got.mergeInstances(got, got.create({
		options: {
			headers: {
				'user-agent': null
			}
		}
	}));

	t.is(instance.defaults.options.headers['user-agent'], null);
});
