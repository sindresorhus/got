import http = require('http');
import test from 'ava';
import is from '@sindresorhus/is';
import got from '../source';
import withServer from './helpers/with-server';

type TestReturn = Record<string, unknown>;

const echoHeaders = (request, response) => {
	request.resume();
	response.end(JSON.stringify(request.headers));
};

test('preserves global defaults', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const globalHeaders = await got('').json();
	const instanceHeaders = await got.extend()('').json();
	t.deepEqual(instanceHeaders, globalHeaders);
});

test('supports instance defaults', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		headers: {
			'user-agent': 'custom-ua-string'
		}
	});
	const headers = await instance('').json();
	t.is(headers['user-agent'], 'custom-ua-string');
});

test('supports invocation overrides', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		headers: {
			'user-agent': 'custom-ua-string'
		}
	});
	const headers = await instance({
		headers: {
			'user-agent': 'different-ua-string'
		}
	}).json();
	t.is(headers['user-agent'], 'different-ua-string');
});

test('carries previous instance defaults', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

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
	const headers = await instanceB('').json();
	t.is(headers['x-foo'], 'foo');
	t.is(headers['x-bar'], 'bar');
});

test('custom headers (extend)', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const options = {headers: {unicorn: 'rainbow'}};

	const instance = got.extend(options);
	const headers = await instance('').json();
	t.is(headers.unicorn, 'rainbow');
});

test('extend overwrites arrays with a deep clone', t => {
	const beforeRequest = [0];
	// @ts-ignore Manual tests
	const a = got.extend({hooks: {beforeRequest}});
	beforeRequest[0] = 1;
	// @ts-ignore Manual tests
	t.deepEqual(a.defaults.options.hooks.beforeRequest, [0]);
	// @ts-ignore Manual tests
	t.not(a.defaults.options.hooks.beforeRequest, beforeRequest);
});

test('extend keeps the old value if the new one is undefined', t => {
	const a = got.extend({headers: undefined});
	t.deepEqual(
		a.defaults.options.headers,
		got.defaults.options.headers
	);
});

test('extend merges URL instances', t => {
	// @ts-ignore Custom instance.
	const a = got.extend({custom: new URL('https://example.com')});
	// @ts-ignore Custom instance.
	const b = a.extend({custom: '/foo'});
	// @ts-ignore Custom instance.
	t.is(b.defaults.options.custom.toString(), 'https://example.com/foo');
});

test('create', withServer, async (t, server) => {
	server.all('/', echoHeaders);

	const instance = got.create({
		options: {},
		handlers: [
			(options, next) => {
				options.headers.unicorn = 'rainbow';
				return next(options);
			}
		]
	});
	const headers = await instance(server.url).json<TestReturn>();
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['user-agent'], undefined);
});

test('hooks are merged on got.extend()', t => {
	const hooksA = [() => {}];
	const hooksB = [() => {}];

	const instanceA = got.create({options: {hooks: {beforeRequest: hooksA}}});

	const extended = instanceA.extend({hooks: {beforeRequest: hooksB}});
	t.deepEqual(extended.defaults.options.hooks.beforeRequest, hooksA.concat(hooksB));
});

test('custom endpoint with custom headers (extend)', withServer, async (t, server) => {
	server.all('/', echoHeaders);

	const instance = got.extend({headers: {unicorn: 'rainbow'}, prefixUrl: server.url});
	const headers = await instance('').json<TestReturn>();
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('no tampering with defaults', t => {
	const instance = got.create({
		handlers: got.defaults.handlers,
		options: got.mergeOptions(got.defaults.options, {
			prefixUrl: 'example/'
		})
	});

	const instance2 = instance.create({
		handlers: instance.defaults.handlers,
		options: instance.defaults.options
	});

	// Tamper Time
	t.throws(() => {
		instance.defaults.options.prefixUrl = 'http://google.com';
	});

	t.is(instance.defaults.options.prefixUrl, 'example/');
	t.is(instance2.defaults.options.prefixUrl, 'example/');
});

test('defaults can be mutable', t => {
	const instance = got.create({
		mutableDefaults: true,
		options: {
			followRedirect: false
		}
	});

	t.notThrows(() => {
		instance.defaults.options.followRedirect = true;
	});

	t.true(instance.defaults.options.followRedirect);
});

test('can set mutable defaults using got.extend', t => {
	const instance = got.extend({
		mutableDefaults: true,
		followRedirect: false
	});

	t.notThrows(() => {
		instance.defaults.options.followRedirect = true;
	});

	t.true(instance.defaults.options.followRedirect);
});

test('only plain objects are freezed', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		agent: new http.Agent({keepAlive: true})
	});

	await t.notThrowsAsync(() => instance(''));
});

test('defaults are cloned on instance creation', t => {
	const options = {foo: 'bar', hooks: {beforeRequest: [() => {}]}};
	const instance = got.create({options});

	t.notThrows(() => {
		options.foo = 'foo';
		delete options.hooks.beforeRequest[0];
	});

	// @ts-ignore This IS correct
	t.not(options.foo, instance.defaults.options.foo);
	t.not(options.hooks.beforeRequest, instance.defaults.options.hooks.beforeRequest);
});

test('ability to pass a custom request method', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let called = false;

	const request = (...args) => {
		called = true;
		// @ts-ignore
		return http.request(...args);
	};

	const instance = got.extend({request});
	await instance('');

	t.true(called);
});

test('hooks aren\'t overriden when merging options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let called = false;
	const instance = got.extend({
		hooks: {
			beforeRequest: [
				() => {
					called = true;
				}
			]
		}
	});

	await instance({});

	t.true(called);
});

test('extend with custom handlers', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		handlers: [
			(options, next) => {
				options.headers.unicorn = 'rainbow';
				return next(options);
			}
		]
	});
	const headers = await instance('').json();
	t.is(headers.unicorn, 'rainbow');
});

test('extend with instances', t => {
	const a = got.extend({prefixUrl: new URL('https://example.com/')});
	const b = got.extend(a);
	t.is(b.defaults.options.prefixUrl.toString(), 'https://example.com/');
});

test('extend with a chain', t => {
	const a = got.extend({prefixUrl: 'https://example.com/'});
	const b = got.extend(a, {headers: {foo: 'bar'}});
	t.is(b.defaults.options.prefixUrl.toString(), 'https://example.com/');
	t.is(b.defaults.options.headers.foo, 'bar');
});

test('async handlers', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		handlers: [
			async (options, next) => {
				const result = await next(options);
				result.modified = true;

				return result;
			}
		]
	});

	const promise = instance('');
	t.true(is.function_(promise.cancel));
	t.true((await promise).modified);
});
