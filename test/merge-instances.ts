import test from 'ava';
import {Handler} from 'express';
import got, {BeforeRequestHook, Got, Headers} from '../source';
import withServer from './helpers/with-server';

const echoHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

test('merging instances', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({prefixUrl: server.url});
	const merged = instanceA.extend(instanceB);

	const headers = await merged('').json<Headers>();
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('merges default handlers & custom handlers', withServer, async (t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({
		handlers: [
			(options, next) => {
				options.headers.cat = 'meow';
				return next(options);
			}
		]
	});
	const merged = instanceA.extend(instanceB);

	const headers = await merged(server.url).json<Headers>();
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

	const headers = await doubleMerged(server.url).json<Headers>();
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

	const headers = await merged(server.url).json<Headers>();
	t.is(headers.dog, 'woof');
	t.is(headers.cat, 'meow');
	t.is(headers.bird, 'tweet');
	t.is(headers.mouse, 'squeek');
});

test('hooks are merged', t => {
	const getBeforeRequestHooks = (instance: Got): BeforeRequestHook[] => instance.defaults.options.hooks.beforeRequest;

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

test('default handlers are not duplicated', t => {
	const instance = got.extend(got);
	t.is(instance.defaults.handlers.length, 1);
});
