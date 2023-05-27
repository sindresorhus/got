import {
	Agent as HttpAgent,
	request as httpRequest,
	type IncomingMessage,
	type RequestOptions,
} from 'node:http';
import test from 'ava';
import is from '@sindresorhus/is';
import type {Handler} from 'express';
import delay from 'delay';
import got, {
	Options,
	type BeforeRequestHook,
	type Headers,
	type Hooks,
	type OptionsInit,
	type RequestFunction,
} from '../source/index.js';
import withServer from './helpers/with-server.js';

const echoHeaders: Handler = (request, response) => {
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
			'user-agent': 'custom-ua-string',
		},
	});
	const headers = await instance('').json<Headers>();
	t.is(headers['user-agent'], 'custom-ua-string');
});

test('supports invocation overrides', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		headers: {
			'user-agent': 'custom-ua-string',
		},
	});
	const headers = await instance({
		headers: {
			'user-agent': 'different-ua-string',
		},
	}).json<Headers>();
	t.is(headers['user-agent'], 'different-ua-string');
});

test('carries previous instance defaults', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({
		headers: {
			'x-foo': 'foo',
		},
	});
	const instanceB = instanceA.extend({
		headers: {
			'x-bar': 'bar',
		},
	});
	const headers = await instanceB('').json<Headers>();
	t.is(headers['x-foo'], 'foo');
	t.is(headers['x-bar'], 'bar');
});

test('custom headers (extend)', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const options = {headers: {unicorn: 'rainbow'}};

	const instance = got.extend(options);
	const headers = await instance('').json<Headers>();
	t.is(headers.unicorn, 'rainbow');
});

test('extend overwrites arrays with a deep clone', t => {
	const x = () => {};
	const y = () => {};

	const beforeRequest = [x];
	const a = got.extend({hooks: {beforeRequest} as unknown as Hooks});
	beforeRequest[0] = y;
	t.deepEqual(a.defaults.options.hooks.beforeRequest, [x] as unknown as BeforeRequestHook[]);
	t.not(a.defaults.options.hooks.beforeRequest, beforeRequest as unknown as BeforeRequestHook[]);
});

test('hooks are merged on got.extend()', t => {
	const hooksA = [() => {}];
	const hooksB = [() => {}];

	const instanceA = got.extend({hooks: {beforeRequest: hooksA}});

	const extended = instanceA.extend({hooks: {beforeRequest: hooksB}});
	t.deepEqual(extended.defaults.options.hooks.beforeRequest, [...hooksA, ...hooksB]);
});

test('custom endpoint with custom headers (extend)', withServer, async (t, server) => {
	server.all('/', echoHeaders);

	const instance = got.extend({headers: {unicorn: 'rainbow'}, prefixUrl: server.url});
	const headers = await instance('').json<Headers>();
	t.is(headers.unicorn, 'rainbow');
	t.not(headers['user-agent'], undefined);
});

test('no tampering with defaults', t => {
	t.throws(() => {
		got.defaults.options.prefixUrl = 'http://google.com';
	});

	t.is(got.defaults.options.prefixUrl, '');
});

test('can set defaults to `new Options(...)`', t => {
	const instance = got.extend({
		mutableDefaults: true,
		followRedirect: false,
	});

	t.notThrows(() => {
		instance.defaults.options = new Options({
			followRedirect: false,
		}, undefined, instance.defaults.options);
	});

	t.false(instance.defaults.options.followRedirect);

	t.notThrows(() => {
		instance.defaults.options = new Options({});
	});

	t.true(instance.defaults.options.followRedirect);
});

test('can set mutable defaults using got.extend', t => {
	const instance = got.extend({
		mutableDefaults: true,
		followRedirect: false,
	});

	t.notThrows(() => {
		instance.defaults.options.followRedirect = true;
	});

	t.true(instance.defaults.options.followRedirect);
});

test('only plain objects are freezed', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		agent: {
			http: new HttpAgent({keepAlive: true}),
		},
		mutableDefaults: true,
	});

	t.notThrows(() => {
		(instance.defaults.options.agent as any).http.keepAlive = true;
	});
});

// eslint-disable-next-line ava/no-skip-test
test.skip('defaults are cloned on instance creation', t => {
	const options: OptionsInit = {hooks: {beforeRequest: [() => {}]}};
	const instance = got.extend(options);
	const context = {
		foo: {},
	};

	t.notThrows(() => {
		options.context = context;
		delete options.hooks!.beforeRequest![0];
	});

	t.not(options.context!.foo, instance.defaults.options.context.foo);
	t.not(options.hooks!.beforeRequest, instance.defaults.options.hooks.beforeRequest);
});

test('ability to pass a custom request method', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let isCalled = false;

	const request: RequestFunction = (...args: [
		string | URL | RequestOptions,
		(RequestOptions | ((response: IncomingMessage) => void))?,
		((response: IncomingMessage) => void)?,
	]) => {
		isCalled = true;
		// @ts-expect-error Overload error
		return httpRequest(...args);
	};

	const instance = got.extend({request});
	await instance('');

	t.true(isCalled);
});

test('does not include the `request` option in normalized `http` options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let isCalled = false;

	const request: RequestFunction = (...args: [
		string | URL | RequestOptions,
		(RequestOptions | ((response: IncomingMessage) => void))?,
		((response: IncomingMessage) => void)?,
	]) => {
		isCalled = true;

		t.false(Reflect.has(args[0] as RequestOptions, 'request'));

		// @ts-expect-error Overload error
		return httpRequest(...args);
	};

	const instance = got.extend({request});
	await instance('');

	t.true(isCalled);
});

test('should pass an options object into an initialization hook after .extend', withServer, async (t, server, got) => {
	t.plan(1);

	server.get('/', echoHeaders);

	let first = true;

	const instance = got.extend({
		hooks: {
			init: [
				options => {
					if (!first) {
						t.deepEqual(options, {});
					}

					first = false;
				},
			],
		},
	});

	await instance('', {});
});

test('hooks aren\'t overriden when merging options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let isCalled = false;
	const instance = got.extend({
		hooks: {
			beforeRequest: [
				() => {
					isCalled = true;
				},
			],
		},
	});

	await instance({});

	t.true(isCalled);
});

test('extend with custom handlers', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		handlers: [
			(options, next) => {
				options.headers.unicorn = 'rainbow';
				return next(options);
			},
		],
	});
	const headers = await instance('').json<Headers>();
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
			(options, next) => {
				if (options.isStream) {
					return next(options);
				}

				return (async () => {
					const result = await next(options);
					// @ts-expect-error Manual tests
					result.modified = true;

					return result;
				})();
			},
		],
	});

	const promise = instance('');
	t.true(is.function_(promise.cancel));
	// @ts-expect-error Manual tests
	t.true((await promise).modified);
});

test('async handlers can throw', async t => {
	const message = 'meh';

	const instance = got.extend({
		handlers: [
			async () => {
				throw new Error(message);
			},
		],
	});

	await t.throwsAsync(instance('https://example.com'), {
		instanceOf: Error,
		message,
	});
});

test('setting dnsCache to true points to global cache', t => {
	const a = got.extend({
		dnsCache: true,
	});

	const b = got.extend({
		dnsCache: true,
	});

	t.is(a.defaults.options.dnsCache, b.defaults.options.dnsCache);
});

test('waits for handlers to finish', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		handlers: [
			async (options, next) => {
				await delay(1000);
				return next(options);
			},
			async (options, next) => {
				options.headers.foo = 'bar';
				return next(options);
			},
		],
	});

	const {foo} = await instance('').json<{foo: 'bar'}>();
	t.is(foo, 'bar');
});

test('does not append to internal _init on new requests', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		mutableDefaults: true,
	});

	const {length} = (instance.defaults.options as any)._init;

	await got('', {
		context: {},
	});

	t.is((instance.defaults.options as any)._init.length, length);
});
