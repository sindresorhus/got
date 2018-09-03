import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		request.resume();
		response.end(JSON.stringify(request.headers));
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('merging instances', async t => {
	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({baseUrl: s.url});
	const merged = got.mergeInstances(instanceA, instanceB);

	const headers = (await merged('/', {json: true})).body;
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('works even if no default handler in the end', async t => {
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

test('merges default handlers & custom handlers', async t => {
	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.create({
		options: {},
		handler: (options, next) => {
			options.headers.cat = 'meow';
			return next(options);
		}
	});
	const merged = got.mergeInstances(instanceA, instanceB);

	const {body: headers} = await merged(s.url, {json: true});
	t.is(headers.unicorn, 'rainbow');
	t.is(headers.cat, 'meow');
});

test('merging one group & one instance', async t => {
	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const merged = got.mergeInstances(instanceA, instanceB, instanceC);
	const doubleMerged = got.mergeInstances(merged, instanceD);

	const headers = (await doubleMerged(s.url, {json: true})).body;
	t.is(headers.dog, 'woof');
	t.is(headers.cat, 'meow');
	t.is(headers.bird, 'tweet');
	t.is(headers.mouse, 'squeek');
});

test('merging two groups of merged instances', async t => {
	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const groupA = got.mergeInstances(instanceA, instanceB);
	const groupB = got.mergeInstances(instanceC, instanceD);

	const merged = got.mergeInstances(groupA, groupB);

	const headers = (await merged(s.url, {json: true})).body;
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
