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

test('extend overwrites arrays', t => {
	const statusCodes = [408];
	const a = got.extend({retry: {statusCodes}});
	t.deepEqual(a.defaults.options.retry.statusCodes, statusCodes);
	t.not(a.defaults.options.retry.statusCodes, statusCodes);
});

test('extend overwrites null', t => {
	const statusCodes = null;
	const a = got.extend({retry: {statusCodes}});
	t.is(a.defaults.options.retry.statusCodes, statusCodes);
});

test('extend ignores source values set to undefined', t => {
	const a = got.extend({
		headers: {foo: undefined, 'user-agent': undefined}
	});
	const b = a.extend({headers: {foo: undefined}});
	t.deepEqual(
		b.defaults.options.headers,
		got.defaults.options.headers
	);
});

test('extend merges URL instances', t => {
	const a = got.extend({baseUrl: new URL('https://example.com')});
	const b = a.extend({baseUrl: '/foo'});
	t.is(b.defaults.options.baseUrl.toString(), 'https://example.com/foo');
});

test('extend ignores object values set to undefined (root keys)', t => {
	t.true(Reflect.has(got.defaults.options, 'headers'));
	const a = got.extend({headers: undefined});
	t.deepEqual(a.defaults.options, got.defaults.options);
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
