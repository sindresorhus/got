import {Readable} from 'node:stream';
import {Buffer} from 'node:buffer';
import {
	Agent as HttpAgent,
	request as httpRequest,
	type IncomingMessage,
	type RequestOptions,
} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import type {LookupFunction} from 'node:net';
import tls from 'node:tls';
import test from 'ava';
import is from '@sindresorhus/is';
import type {Handler} from 'express';
import delay from 'delay';
import getStream from 'get-stream';
import got, {
	UploadError,
	Options,
	type BeforeRequestHook,
	type Headers,
	type OptionsInit,
	type RequestFunction,
} from '../source/index.js';
import {Http2Agent} from '../source/core/utils/http2-client.js';
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

	const beforeRequest: BeforeRequestHook[] = [x];
	const a = got.extend({hooks: {beforeRequest}});
	beforeRequest[0] = y;
	t.deepEqual(a.defaults.options.hooks.beforeRequest, [x]);
	t.not(a.defaults.options.hooks.beforeRequest, beforeRequest);
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

test('mixed-case header introspection does not throw on frozen defaults', t => {
	t.notThrows(() => {
		Object.hasOwn(got.defaults.options.headers, 'User-Agent');
		Object.getOwnPropertyDescriptor(got.defaults.options.headers, 'User-Agent');
	});

	t.is(got.defaults.options.headers['User-Agent'], got.defaults.options.headers['user-agent']);
});

test('failed header writes on frozen defaults do not mark headers as explicit', t => {
	t.throws(() => {
		got.defaults.options.headers.foo = 'bar';
	}, {
		instanceOf: TypeError,
	});

	t.false(got.defaults.options.isHeaderExplicitlySet('foo'));
});

test('failed header deletes on frozen defaults do not unmark explicit headers', t => {
	const instance = got.extend({
		headers: {
			foo: 'bar',
		},
	});

	t.true(instance.defaults.options.isHeaderExplicitlySet('foo'));

	t.throws(() => {
		delete instance.defaults.options.headers.foo;
	}, {
		instanceOf: TypeError,
	});

	t.true(instance.defaults.options.isHeaderExplicitlySet('foo'));
});

test('can unset mutable default abort signal', t => {
	const firstController = new AbortController();
	const instance = got.extend({
		mutableDefaults: true,
		signal: firstController.signal,
	});

	t.is(instance.defaults.options.signal, firstController.signal);

	t.notThrows(() => {
		instance.defaults.options.signal = undefined;
	});

	t.is(instance.defaults.options.signal, undefined);
});

test('normalizes https.pfx object arrays for native request options', t => {
	const options = new Options('https://example.com', {
		https: {
			pfx: [{
				buffer: Buffer.from('hello'),
				passphrase: 'world',
			}],
		},
	});

	const nativeRequestOptions = options.createNativeRequestOptions();
	t.deepEqual(nativeRequestOptions.pfx, [{
		buf: Buffer.from('hello'),
		passphrase: 'world',
	}]);
});

test('normalized https.pfx object arrays keep stable HTTP/2 session keys', t => {
	const createOptions = (buffer: Uint8Array) => new Options('https://example.com', {
		http2: true,
		https: {
			pfx: [{
				buffer,
				passphrase: 'world',
			}],
		},
	});
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const options = createOptions(Buffer.from('hello'));
	const differentOptions = createOptions(Buffer.from('different'));
	const createNativeRequestOptions = () => options.createNativeRequestOptions() as Parameters<Http2Agent['normalizeOptions']>[1];

	t.is(
		agent.normalizeOptions(origin, createNativeRequestOptions()),
		agent.normalizeOptions(origin, createNativeRequestOptions()),
	);
	t.not(
		agent.normalizeOptions(origin, createNativeRequestOptions()),
		agent.normalizeOptions(origin, differentOptions.createNativeRequestOptions() as Parameters<Http2Agent['normalizeOptions']>[1]),
	);
});

test('HTTP/2 session keys distinguish colon-containing TLS options', t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');

	t.not(
		agent.normalizeOptions(origin, {cert: 'a:b', key: 'c'}),
		agent.normalizeOptions(origin, {cert: 'a', key: 'b:c'}),
	);
});

test('HTTP/2 session keys distinguish opaque TLS key objects', t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const firstKeyPair = generateKeyPairSync('rsa', {modulusLength: 512});
	const secondKeyPair = generateKeyPairSync('rsa', {modulusLength: 512});
	const createRequestOptions = (key: typeof firstKeyPair.privateKey) => ({key: [key]}) as unknown as Parameters<Http2Agent['normalizeOptions']>[1];

	t.is(
		agent.normalizeOptions(origin, createRequestOptions(firstKeyPair.privateKey)),
		agent.normalizeOptions(origin, createRequestOptions(firstKeyPair.privateKey)),
	);
	t.not(
		agent.normalizeOptions(origin, createRequestOptions(firstKeyPair.privateKey)),
		agent.normalizeOptions(origin, createRequestOptions(secondKeyPair.privateKey)),
	);
});

test('HTTP/2 session keys distinguish secure contexts', t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const firstContext = tls.createSecureContext();
	const secondContext = tls.createSecureContext();

	t.is(
		agent.normalizeOptions(origin, {secureContext: firstContext}),
		agent.normalizeOptions(origin, {secureContext: firstContext}),
	);
	t.not(
		agent.normalizeOptions(origin, {secureContext: firstContext}),
		agent.normalizeOptions(origin, {secureContext: secondContext}),
	);
});

test('HTTP/2 session keys distinguish secure protocols', t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');

	t.not(
		agent.normalizeOptions(origin, {secureProtocol: 'TLS_method'}),
		agent.normalizeOptions(origin, {secureProtocol: 'TLSv1_2_method'}),
	);
});

test('HTTP/2 session keys distinguish DNS lookup options', t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const firstLookup: LookupFunction = () => {};
	const secondLookup: LookupFunction = () => {};

	t.is(
		agent.normalizeOptions(origin, {lookup: firstLookup}),
		agent.normalizeOptions(origin, {lookup: firstLookup}),
	);
	t.not(
		agent.normalizeOptions(origin, {lookup: firstLookup}),
		agent.normalizeOptions(origin, {lookup: secondLookup}),
	);
	t.not(
		agent.normalizeOptions(origin, {family: 4}),
		agent.normalizeOptions(origin, {family: 6}),
	);
});

test('passes DNS cache lookup and IP version to native request options', t => {
	let lookupArguments: Parameters<LookupFunction> | undefined;
	const lookup: LookupFunction = (...arguments_) => {
		lookupArguments = arguments_;
	};

	const dnsLookup: LookupFunction = () => {};
	const options = new Options('https://example.com', {
		dnsCache: {
			lookup,
		},
		dnsLookupIpVersion: 6,
	});

	const nativeRequestOptions = options.createNativeRequestOptions();
	const lookupOptions = {family: 6};
	const callback = () => {};
	nativeRequestOptions.lookup!('example.com', lookupOptions, callback);
	t.deepEqual(lookupArguments, ['example.com', lookupOptions, callback]);
	t.is(nativeRequestOptions.family, 6);

	options.dnsLookup = dnsLookup;
	t.is(options.createNativeRequestOptions().lookup, dnsLookup);
});

test('HTTP/2 option on HTTP preserves disabled HTTP agent', t => {
	const options = new Options('http://example.com', {
		http2: true,
		agent: {
			http: false,
		},
	});

	t.is(options.createNativeRequestOptions().agent, false);
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

test('defaults are cloned on instance creation', t => {
	const options: OptionsInit = {hooks: {beforeRequest: [() => {}]}};
	const instance = got.extend(options);
	const context = {
		foo: {},
	};

	t.notThrows(() => {
		options.context = context;
		options.hooks!.beforeRequest!.splice(0, 1);
	});

	t.not(options.context!.foo, instance.defaults.options.context.foo);
	t.not(options.hooks!.beforeRequest, instance.defaults.options.hooks.beforeRequest);
});

test('ability to pass a custom request method', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let isCalled = false;

	const request: RequestFunction = (...arguments_: [
		string | URL | RequestOptions,
		(RequestOptions | ((response: IncomingMessage) => void))?,
		((response: IncomingMessage) => void)?,
	]) => {
		isCalled = true;
		// @ts-expect-error Overload error
		return httpRequest(...arguments_);
	};

	const instance = got.extend({request});
	await instance('');

	t.true(isCalled);
});

test('does not include the `request` option in normalized `http` options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let isCalled = false;

	const request: RequestFunction = (...arguments_: [
		string | URL | RequestOptions,
		(RequestOptions | ((response: IncomingMessage) => void))?,
		((response: IncomingMessage) => void)?,
	]) => {
		isCalled = true;

		t.false(Reflect.has(arguments_[0] as RequestOptions, 'request'));

		// @ts-expect-error Overload error
		return httpRequest(...arguments_);
	};

	const instance = got.extend({request});
	await instance('');

	t.true(isCalled);
});

test('should pass an options object into an initialization hook after .extend', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	let first = true;
	let secondCallOptions: unknown;

	const instance = got.extend({
		hooks: {
			init: [
				options => {
					if (!first) {
						secondCallOptions = options;
					}

					first = false;
				},
			],
		},
	});

	await instance('', {});

	t.deepEqual(secondCallOptions, {});
});

test('handlers detect stream mode via `options.isStream`', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let promiseModeCount = 0;
	let streamModeCount = 0;

	const instance = got.extend({
		handlers: [
			(options, next) => {
				if (options.isStream) {
					streamModeCount++;
				} else {
					promiseModeCount++;
				}

				return next(options);
			},
		],
	});

	await instance('').text();

	const stream = instance.stream('');
	await new Promise<void>((resolve, reject) => {
		stream.once('end', resolve);
		stream.once('error', reject);
		stream.resume();
	});

	t.is(promiseModeCount, 1);
	t.is(streamModeCount, 1);
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
	t.true(is.function(promise.json));
	t.true(is.function(promise.once));

	let responseEventCount = 0;
	const returnedPromise = promise.once('response', () => {
		responseEventCount++;
	});
	t.is(returnedPromise, promise);

	// @ts-expect-error Manual tests
	t.true((await promise).modified);
	t.is(responseEventCount, 1);
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

test('setting dnsCache to false disables inherited DNS cache', t => {
	const instance = got.extend({
		dnsCache: true,
	}).extend({
		dnsCache: false,
	});
	const options = new Options('https://example.com', {
		dnsCache: true,
	});
	options.dnsCache = false;

	t.is(instance.defaults.options.dnsCache, undefined);
	t.is(options.createNativeRequestOptions().lookup, undefined);
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

test('does not leak per-request options into extended defaults', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		mutableDefaults: true,
	});

	await instance('', {
		headers: {
			'x-transient': 'present-once',
		},
	});

	const extendedInstance = instance.extend({});
	const headers = await extendedInstance('').json<Record<string, string>>();

	t.is(headers['x-transient'], undefined);
});

test('extend clones searchParams object', t => {
	const searchParameters = {foo: 'bar', page: '1'};
	const instance = got.extend({searchParams: searchParameters});

	// Mutate the original
	searchParameters.foo = 'changed';
	searchParameters.page = '999';

	// Instance should have the original values (converted to URLSearchParams)
	const instanceParameters = instance.defaults.options.searchParams as URLSearchParams;
	t.is(instanceParameters.get('foo'), 'bar');
	t.is(instanceParameters.get('page'), '1');
});

test('extend clones URLSearchParams instance', t => {
	const searchParameters = new URLSearchParams({foo: 'bar', page: '1'});
	const instance = got.extend({searchParams: searchParameters});

	// Mutate the original
	searchParameters.set('foo', 'changed');
	searchParameters.set('page', '999');

	// Instance should have the original values
	const instanceParameters = instance.defaults.options.searchParams as URLSearchParams;
	t.is(instanceParameters.get('foo'), 'bar');
	t.is(instanceParameters.get('page'), '1');
	t.not(instanceParameters, searchParameters);
});

test('extend handles string searchParams', t => {
	const searchParameters = 'foo=bar&page=1';
	const instance = got.extend({searchParams: searchParameters});

	// String gets converted to URLSearchParams
	const instanceParameters = instance.defaults.options.searchParams as URLSearchParams;
	t.is(instanceParameters.get('foo'), 'bar');
	t.is(instanceParameters.get('page'), '1');
});

test('extended instances carry searchParams', t => {
	const instanceA = got.extend({
		searchParams: {foo: 'bar'},
	});

	const instanceB = instanceA.extend({
		searchParams: {page: '1'},
	});

	const instanceParametersB = instanceB.defaults.options.searchParams as URLSearchParams;
	t.is(instanceParametersB.get('foo'), 'bar');
	t.is(instanceParametersB.get('page'), '1');
});

test('extend creates independent searchParams copies', t => {
	const searchParameters = {foo: 'bar'};
	const instanceA = got.extend({searchParams: searchParameters, mutableDefaults: true});
	const instanceB = got.extend({searchParams: searchParameters, mutableDefaults: true});

	// Modify instanceA's searchParams
	(instanceA.defaults.options.searchParams as URLSearchParams).set('foo', 'modified');

	// InstanceB should be unaffected
	t.is((instanceB.defaults.options.searchParams as URLSearchParams).get('foo'), 'bar');
});

test('got.extend() with responseType works at runtime', withServer, async (t, server) => {
	server.get('/json', (_request, response) => {
		response.writeHead(200, {'content-type': 'application/json'});
		response.end('{"data": "test"}');
	});

	server.get('/buffer', (_request, response) => {
		response.writeHead(200, {'content-type': 'application/octet-stream'});
		response.end(Buffer.from('binary'));
	});

	// Test responseType: 'json' works
	const jsonClient = got.extend({
		prefixUrl: server.url,
		responseType: 'json',
	});

	const jsonResponse = await jsonClient('json');
	t.deepEqual(jsonResponse.body, {data: 'test'});

	// Test responseType: 'buffer' works
	const bufferClient = got.extend({
		prefixUrl: server.url,
		responseType: 'buffer',
	});

	const bufferResponse = await bufferClient('buffer');
	t.true(bufferResponse.body instanceof Uint8Array);
	t.false(Buffer.isBuffer(bufferResponse.body));
	t.is(Buffer.from(bufferResponse.body).toString(), 'binary');

	// Test resolveBodyOnly works with extended responseType
	const jsonBodyClient = got.extend({
		prefixUrl: server.url,
		responseType: 'json',
		resolveBodyOnly: true,
	});

	const jsonBody = await jsonBodyClient('json');
	t.deepEqual(jsonBody, {data: 'test'});
});

test('extend preserves an explicit mutableDefaults setting across later options', t => {
	const instance = got.extend({mutableDefaults: true}, {headers: {'x-test': 'original'}});

	t.true(instance.defaults.mutableDefaults);
	instance.defaults.options.headers['x-test'] = 'updated';
	t.is(instance.defaults.options.headers['x-test'], 'updated');
});

for (const mutableDefaults of [true, false]) {
	test(`extend retains explicit mutableDefaults ${mutableDefaults} through omitted values`, t => {
		const instance = got.extend({mutableDefaults: !mutableDefaults}, {mutableDefaults}, {}, {mutableDefaults: undefined});

		t.is(instance.defaults.mutableDefaults, mutableDefaults);
		t.is(Object.isFrozen(instance.defaults.options.headers), !mutableDefaults);
	});
}

test('extend retains merged instance mutability through later options', t => {
	const mutableInstance = got.extend({mutableDefaults: true});
	const instance = got.extend(mutableInstance, {headers: {'x-test': 'original'}});

	t.true(instance.defaults.mutableDefaults);
	instance.defaults.options.headers['x-test'] = 'updated';
	t.is(instance.defaults.options.headers['x-test'], 'updated');
	t.is(mutableInstance.defaults.options.headers['x-test'], undefined);
});

test('extend allows later instances to override explicit mutability', t => {
	const mutableInstance = got.extend({mutableDefaults: true});
	const frozenInstance = got.extend({mutableDefaults: false});

	t.true(got.extend({mutableDefaults: false}, mutableInstance, {}).defaults.mutableDefaults);
	t.false(got.extend({mutableDefaults: true}, frozenInstance, {}).defaults.mutableDefaults);
});

test('chained instances preserve inherited response defaults', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});

	const parent = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const child = parent.extend({headers: {'x-test': 'yes'}}).extend();

	t.deepEqual(await child(''), new Uint8Array(Buffer.from('hello')));
	t.is(await child.extend({responseType: 'text'})(''), 'hello');
	t.deepEqual((await child.extend({resolveBodyOnly: false})('')).body, new Uint8Array(Buffer.from('hello')));
});

test('extend merges arrays of configuration layers in order', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});

	const layers = [{headers: {'x-first': 'one'}}, {headers: {'x-second': 'two'}}];
	const parent = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const child = parent.extend(...layers);

	t.deepEqual(await child(''), new Uint8Array(Buffer.from('hello')));
	t.is(child.defaults.options.headers['x-first'], 'one');
	t.is(child.defaults.options.headers['x-second'], 'two');
	t.is(await parent.extend(...layers, {responseType: 'text'})(''), 'hello');
});

test('undefined response defaults do not override parent instances', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});

	const parent = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const child = parent.extend({responseType: undefined, resolveBodyOnly: undefined});

	t.deepEqual(await child(''), new Uint8Array(Buffer.from('hello')));
	t.is(child.defaults.options.responseType, 'buffer');
	t.true(child.defaults.options.resolveBodyOnly);
	t.is((await child.extend({responseType: 'text', resolveBodyOnly: false})('')).body, 'hello');
});

for (const responseType of ['text', 'buffer'] as const) {
	for (const resolveBodyOnly of [true, false]) {
		test(`dynamic defaults return ${responseType} with body-only ${resolveBodyOnly}`, withServer, async (t, server, got) => {
			server.get('/', (_request, response) => {
				response.end('hello');
			});

			const client = got.extend({responseType, resolveBodyOnly});
			const response = await client('');
			const expectedBody = responseType === 'buffer' ? new Uint8Array(Buffer.from('hello')) : 'hello';

			if (resolveBodyOnly) {
				t.deepEqual(response, expectedBody);
			} else {
				t.like(response, {body: expectedBody, statusCode: 200});
			}
		});
	}
}

test('immutable defaults cannot be replaced', t => {
	const client = got.extend({headers: {'x-test': 'original'}});

	t.throws(() => {
		client.defaults.options = new Options({headers: {'x-test': 'replacement'}});
	}, {instanceOf: TypeError});
	t.is(client.defaults.options.headers['x-test'], 'original');
});

test('immutable handler defaults cannot be replaced or deleted', t => {
	const client = got.extend();
	const {handlers} = client.defaults;

	t.throws(() => {
		client.defaults.handlers = [];
	}, {instanceOf: TypeError});
	t.false(Reflect.deleteProperty(client.defaults, 'handlers'));
	t.false(Reflect.deleteProperty(client.defaults, 'options'));
	t.is(client.defaults.handlers, handlers);
});

test('mutable instances can replace options and handlers used by requests', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json([request.headers['x-options'], request.headers['x-handler']]);
	});

	const client = got.extend({mutableDefaults: true});
	client.defaults.options = new Options({headers: {'x-options': 'replacement'}}, undefined, client.defaults.options);
	client.defaults.handlers = [(options, next) => {
		options.headers['x-handler'] = 'replacement';
		return next(options);
	}];

	t.deepEqual(await client('').json(), ['replacement', 'replacement']);
});

test('extending mutable defaults freezes only the new immutable container', t => {
	const parent = got.extend({mutableDefaults: true});
	const child = parent.extend();

	t.true(Object.isFrozen(child.defaults));
	t.false(Object.isFrozen(parent.defaults));
	parent.defaults.options = new Options({headers: {'x-parent': 'changed'}});
	t.is(child.defaults.options.headers['x-parent'], undefined);
});

for (const mutableDefaults of [true, false]) {
	test(`default bindings remain read-only with mutableDefaults ${mutableDefaults}`, t => {
		const client = got.extend({mutableDefaults});
		const {defaults} = client;

		t.false(Reflect.set(client, 'defaults', got.defaults));
		t.false(Reflect.set(defaults, 'mutableDefaults', !mutableDefaults));
		t.false(Reflect.deleteProperty(client, 'defaults'));
		t.false(Reflect.deleteProperty(defaults, 'mutableDefaults'));
		t.is(client.defaults, defaults);
		t.is(client.defaults.mutableDefaults, mutableDefaults);
	});
}

test('undefined request options preserve inherited response defaults', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});
	const client = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const expected = new Uint8Array(Buffer.from('hello'));

	t.deepEqual(await client('', {responseType: undefined}), expected);
	t.deepEqual(await client({resolveBodyOnly: undefined}), expected);
	t.deepEqual(await client.get('', {responseType: undefined, resolveBodyOnly: undefined}), expected);
	t.deepEqual((await client('', {responseType: undefined, resolveBodyOnly: false})).body, expected);
	t.is(await client({responseType: 'text', resolveBodyOnly: undefined}), 'hello');
});

test('undefined request responseType preserves JSON parsing and wrapped responses', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.json({value: 1});
	});
	const client = got.extend({responseType: 'json'});

	t.deepEqual((await client.post({responseType: undefined, resolveBodyOnly: undefined})).body, {value: 1});
	t.deepEqual(await client.post('', {responseType: undefined, resolveBodyOnly: true}), {value: 1});
});

test('handler-supplied stream body failures are upload errors', withServer, async (t, server, got) => {
	server.post('/', request => {
		request.resume();
	});
	const cause = new Error('Replacement body failed');
	const body = new Readable({
		read() {
			this.destroy(cause);
		},
	});
	// Keep the regression observable as a request failure rather than an uncaught stream error.
	body.on('error', () => {});
	const client = got.extend({
		handlers: [(options, next) => {
			options.body = body;
			return next(options);
		}],
	});

	const error = await t.throwsAsync<UploadError>(client.post('', {retry: {limit: 0}, timeout: {request: 500}}), {
		instanceOf: UploadError,
		code: 'ERR_UPLOAD',
		message: cause.message,
	});

	t.is(error.cause, cause);
});

test('beforeRequest replacement stream errors do not trigger network retries', withServer, async (t, server, got) => {
	server.post('/', request => {
		request.resume();
	});
	const cause = Object.assign(new Error('Hook body failed'), {code: 'ECONNRESET'});
	let retries = 0;
	const body = new Readable({
		read() {
			this.destroy(cause);
		},
	});
	body.on('error', () => {});

	const error = await t.throwsAsync<UploadError>(got.post('', {
		body: 'original',
		timeout: {request: 500},
		retry: {limit: 1, methods: ['POST'], calculateDelay: () => 1},
		hooks: {
			beforeRequest: [options => {
				options.body = body;
			}],
			beforeRetry: [() => {
				retries++;
			}],
		},
	}), {instanceOf: UploadError, code: 'ERR_UPLOAD', message: cause.message});

	t.is(error.cause, cause);
	t.is(retries, 0);
});

test('handler-supplied body failures reach the streaming API', withServer, async (t, server, got) => {
	server.post('/', request => {
		request.resume();
	});
	const cause = new Error('Stream body failed');
	const body = new Readable({
		read() {
			this.destroy(cause);
		},
	});
	body.on('error', () => {});
	const client = got.extend({
		handlers: [(options, next) => {
			options.body = body;
			return next(options);
		}],
	});

	const error = await t.throwsAsync<UploadError>(getStream(client.stream.post('', {timeout: {request: 500}})), {
		instanceOf: UploadError,
		code: 'ERR_UPLOAD',
	});

	t.is(error.cause, cause);
});

test('initial body errors remain handled before asynchronous handlers finish', withServer, async (t, _server, got) => {
	const cause = new Error('Initial body failed');
	const body = new Readable({read() {}});
	const client = got.extend({
		handlers: [async (options, next) => {
			body.destroy(cause);
			await delay(10);
			return next(options);
		}],
	});

	const error = await t.throwsAsync<UploadError>(client.post('', {body}), {instanceOf: UploadError, code: 'ERR_UPLOAD'});

	t.is(error.cause, cause);
});

test('initial stream uploads retain exactly one Got error listener', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	let errorListeners = 0;
	const body = new Readable({
		read() {
			errorListeners = this.listenerCount('error');
			this.push('payload');
			this.push(null);
		},
	});

	t.is(await got.post('', {body}).text(), 'payload');
	t.is(errorListeners, 1);
});
