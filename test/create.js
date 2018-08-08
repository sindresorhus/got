import {URL} from 'url';
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

test('preserve global defaults', async t => {
	const globalHeaders = (await got(s.url, {json: true})).body;
	const instanceHeaders = (await got.extend()(s.url, {json: true})).body;
	t.deepEqual(instanceHeaders, globalHeaders);
});

test('support instance defaults', async t => {
	const instance = got.extend({
		headers: {
			'user-agent': 'custom-ua-string'
		}
	});
	const headers = (await instance(s.url, {json: true})).body;
	t.is(headers['user-agent'], 'custom-ua-string');
});

test('support invocation overrides', async t => {
	const instance = got.extend({
		headers: {
			'user-agent': 'custom-ua-string'
		}
	});
	const headers = (await instance(s.url, {
		json: true,
		headers: {
			'user-agent': 'different-ua-string'
		}
	})).body;
	t.is(headers['user-agent'], 'different-ua-string');
});

test('curry previous instance defaults', async t => {
	const instanceA = got.extend({
		headers: {
			'x-foo': 'foo'
		}
	});
	const instanceB = instanceA.extend({
		headers: {
			'x-bar': 'bar'
		}
	});
	const headers = (await instanceB(s.url, {json: true})).body;
	t.is(headers['x-foo'], 'foo');
	t.is(headers['x-bar'], 'bar');
});

test('custom headers (extend)', async t => {
	const options = {headers: {unicorn: 'rainbow'}};

	const instance = got.extend(options);
	const headers = (await instance(`${s.url}/`, {
		json: true
	})).body;
	t.is(headers.unicorn, 'rainbow');
});

test('extend overwrites arrays with a deep clone', t => {
	const statusCodes = [408];
	const a = got.extend({retry: {statusCodes}});
	statusCodes[0] = 500;
	t.deepEqual(a.defaults.options.retry.statusCodes, [408]);
	t.not(a.defaults.options.retry.statusCodes, statusCodes);
});

test('extend keeps the old value if the new one is undefined', t => {
	const a = got.extend({headers: undefined});
	t.deepEqual(
		a.defaults.options.headers,
		got.defaults.options.headers
	);
});

test('extend merges URL instances', t => {
	const a = got.extend({baseUrl: new URL('https://example.com')});
	const b = a.extend({baseUrl: '/foo'});
	t.is(b.defaults.options.baseUrl.toString(), 'https://example.com/foo');
});

test('create', async t => {
	const instance = got.create({
		options: {},
		methods: ['get'],
		handler: (options, next) => {
			options.headers.unicorn = 'rainbow';
			return next(options);
		}
	});
	const headers = (await instance(s.url, {
		json: true
	})).body;
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['user-agent'], undefined);
});

test('custom endpoint with custom headers (extend)', async t => {
	const instance = got.extend({headers: {unicorn: 'rainbow'}, baseUrl: s.url});
	const headers = (await instance(`/`, {
		json: true
	})).body;
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('no tampering with defaults', t => {
	const instance = got.create({
		handler: got.defaults.handler,
		methods: got.defaults.methods,
		options: got.mergeOptions(got.defaults.options, {
			baseUrl: 'example'
		})
	});

	const instance2 = instance.create({
		handler: instance.defaults.handler,
		methods: instance.defaults.methods,
		options: instance.defaults.options
	});

	// Tamper Time
	t.throws(() => {
		instance.defaults.options.baseUrl = 'http://google.com';
	});

	t.is(instance.defaults.options.baseUrl, 'example');
	t.is(instance2.defaults.options.baseUrl, 'example');
});

test('defaults are cloned on instance creation', t => {
	const options = {foo: 'bar'};
	const methods = ['get'];
	const instance = got.create({
		methods,
		options
	});

	t.notThrows(() => {
		options.foo = 'foo';
		methods[0] = 'post';
	});

	t.not(options.foo, instance.defaults.options.foo);
	t.not(methods[0], instance.defaults.methods[0]);
});

test('merging instances', async t => {
	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({baseUrl: s.url});
	const merged = instanceA.merge(instanceB, ['get']);

	const headers = (await merged('/', {json: true})).body;
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('merging already merged instances & another instance', async t => {
	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const merged = got.merge(instanceA, instanceB, instanceC);
	const doubleMerged = got.merge(merged, instanceD);

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

	const groupA = got.merge(instanceA, instanceB);
	const groupB = got.merge(instanceC, instanceD);

	const merged = groupA.merge(groupB);

	const headers = (await merged(s.url, {json: true})).body;
	t.is(headers.dog, 'woof');
	t.is(headers.cat, 'meow');
	t.is(headers.bird, 'tweet');
	t.is(headers.mouse, 'squeek');
});

test('hooks are merged when merging instances', t => {
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

	const merged = instanceA.merge(instanceB);
	t.deepEqual(getBeforeRequestHooks(merged), getBeforeRequestHooks(instanceA).concat(getBeforeRequestHooks(instanceB)));
});

test('throws when trying to merge unmergeable instance', t => {
	const instanceA = got.extend();
	const instanceB = got.create({
		methods: [],
		options: {},
		mergeable: false
	});

	t.throws(() => instanceA.merge(instanceB));
});
