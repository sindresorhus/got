import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		req.resume();
		res.end(JSON.stringify(req.headers));
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
		options: {
			...got.defaults.options,
			baseUrl: 'example'
		}
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
