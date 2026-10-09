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
import assert from 'node:assert/strict';
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
	type Response,
} from '../source/index.js';
import {Http2Agent} from '../source/core/utils/http2-client.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const echoHeaders: Handler = (request, response) => {
	request.resume();
	response.end(JSON.stringify(request.headers));
};

test('preserves global defaults', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const globalHeaders = await got('').json();
	const instanceHeaders = await got.extend()('').json();
	assert.deepStrictEqual(instanceHeaders, globalHeaders);
});

test('supports instance defaults', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		headers: {
			'user-agent': 'custom-ua-string',
		},
	});
	const headers = await instance('').json<Headers>();
	assert.strictEqual(headers['user-agent'], 'custom-ua-string');
});

test('supports invocation overrides', withServer, async (_t, server, got) => {
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
	assert.strictEqual(headers['user-agent'], 'different-ua-string');
});

test('carries previous instance defaults', withServer, async (_t, server, got) => {
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
	assert.strictEqual(headers['x-foo'], 'foo');
	assert.strictEqual(headers['x-bar'], 'bar');
});

test('custom headers (extend)', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const options = {headers: {unicorn: 'rainbow'}};

	const instance = got.extend(options);
	const headers = await instance('').json<Headers>();
	assert.strictEqual(headers.unicorn, 'rainbow');
});

test('extend overwrites arrays with a deep clone', _t => {
	const x = () => {};
	const y = () => {};

	const beforeRequest: BeforeRequestHook[] = [x];
	const a = got.extend({hooks: {beforeRequest}});
	beforeRequest[0] = y;
	assert.deepStrictEqual(a.defaults.options.hooks.beforeRequest, [x]);
	assert.notStrictEqual(a.defaults.options.hooks.beforeRequest, beforeRequest);
});

test('hooks are merged on got.extend()', _t => {
	const hooksA = [() => {}];
	const hooksB = [() => {}];

	const instanceA = got.extend({hooks: {beforeRequest: hooksA}});

	const extended = instanceA.extend({hooks: {beforeRequest: hooksB}});
	assert.deepStrictEqual(extended.defaults.options.hooks.beforeRequest, [...hooksA, ...hooksB]);
});

test('custom endpoint with custom headers (extend)', withServer, async (_t, server) => {
	server.all('/', echoHeaders);

	const instance = got.extend({headers: {unicorn: 'rainbow'}, prefixUrl: server.url});
	const headers = await instance('').json<Headers>();
	assert.strictEqual(headers.unicorn, 'rainbow');
	assert.notStrictEqual(headers['user-agent'], undefined);
});

test('no tampering with defaults', _t => {
	assert.throws(() => {
		got.defaults.options.prefixUrl = 'http://google.com';
	});

	assert.strictEqual(got.defaults.options.prefixUrl, '');
});

test('mutable defaults keep a writable searchParams', _t => {
	const instance = got.extend({prefixUrl: 'https://example.com', mutableDefaults: true, searchParams: {token: 'abc'}});
	const searchParameters = (): URLSearchParams => instance.defaults.options.searchParams;

	searchParameters().set('extra', 'yes');

	assert.strictEqual(searchParameters().get('extra'), 'yes');
	assert.strictEqual(searchParameters().get('token'), 'abc');
});

test('mixed-case header introspection does not throw on frozen defaults', _t => {
	assert.doesNotThrow(() => {
		Object.hasOwn(got.defaults.options.headers, 'User-Agent');
		Object.getOwnPropertyDescriptor(got.defaults.options.headers, 'User-Agent');
	});

	assert.strictEqual(got.defaults.options.headers['User-Agent'], got.defaults.options.headers['user-agent']);
});

test('failed header writes on frozen defaults do not mark headers as explicit', _t => {
	assert.throws(() => {
		got.defaults.options.headers.foo = 'bar';
	}, TypeError);

	assert.strictEqual(got.defaults.options.isHeaderExplicitlySet('foo'), false);
});

test('failed header deletes on frozen defaults do not unmark explicit headers', _t => {
	const instance = got.extend({
		headers: {
			foo: 'bar',
		},
	});

	assert.strictEqual(instance.defaults.options.isHeaderExplicitlySet('foo'), true);

	assert.throws(() => {
		delete instance.defaults.options.headers.foo;
	}, TypeError);

	assert.strictEqual(instance.defaults.options.isHeaderExplicitlySet('foo'), true);
});

test('can unset mutable default abort signal', _t => {
	const firstController = new AbortController();
	const instance = got.extend({
		mutableDefaults: true,
		signal: firstController.signal,
	});

	assert.strictEqual(instance.defaults.options.signal, firstController.signal);

	assert.doesNotThrow(() => {
		instance.defaults.options.signal = undefined;
	});

	assert.strictEqual(instance.defaults.options.signal, undefined);
});

test('normalizes https.pfx object arrays for native request options', _t => {
	const options = new Options('https://example.com', {
		https: {
			pfx: [{
				buffer: Buffer.from('hello'),
				passphrase: 'world',
			}],
		},
	});

	const nativeRequestOptions = options.createNativeRequestOptions();
	assert.deepStrictEqual(nativeRequestOptions.pfx, [{
		buf: Buffer.from('hello'),
		passphrase: 'world',
	}]);
});

test('normalized https.pfx object arrays keep stable HTTP/2 session keys', _t => {
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

	assert.strictEqual(
		agent.normalizeOptions(origin, createNativeRequestOptions()),
		agent.normalizeOptions(origin, createNativeRequestOptions()),
	);
	assert.notStrictEqual(
		agent.normalizeOptions(origin, createNativeRequestOptions()),
		agent.normalizeOptions(origin, differentOptions.createNativeRequestOptions() as Parameters<Http2Agent['normalizeOptions']>[1]),
	);
});

test('HTTP/2 session keys distinguish colon-containing TLS options', _t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');

	assert.notStrictEqual(
		agent.normalizeOptions(origin, {cert: 'a:b', key: 'c'}),
		agent.normalizeOptions(origin, {cert: 'a', key: 'b:c'}),
	);
});

test('HTTP/2 session keys distinguish opaque TLS key objects', _t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const firstKeyPair = generateKeyPairSync('rsa', {modulusLength: 512});
	const secondKeyPair = generateKeyPairSync('rsa', {modulusLength: 512});
	const createRequestOptions = (key: typeof firstKeyPair.privateKey) => ({key: [key]}) as unknown as Parameters<Http2Agent['normalizeOptions']>[1];

	assert.strictEqual(
		agent.normalizeOptions(origin, createRequestOptions(firstKeyPair.privateKey)),
		agent.normalizeOptions(origin, createRequestOptions(firstKeyPair.privateKey)),
	);
	assert.notStrictEqual(
		agent.normalizeOptions(origin, createRequestOptions(firstKeyPair.privateKey)),
		agent.normalizeOptions(origin, createRequestOptions(secondKeyPair.privateKey)),
	);
});

test('HTTP/2 session keys distinguish secure contexts', _t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const firstContext = tls.createSecureContext();
	const secondContext = tls.createSecureContext();

	assert.strictEqual(
		agent.normalizeOptions(origin, {secureContext: firstContext}),
		agent.normalizeOptions(origin, {secureContext: firstContext}),
	);
	assert.notStrictEqual(
		agent.normalizeOptions(origin, {secureContext: firstContext}),
		agent.normalizeOptions(origin, {secureContext: secondContext}),
	);
});

test('HTTP/2 session keys distinguish secure protocols', _t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');

	assert.notStrictEqual(
		agent.normalizeOptions(origin, {secureProtocol: 'TLS_method'}),
		agent.normalizeOptions(origin, {secureProtocol: 'TLSv1_2_method'}),
	);
});

test('HTTP/2 session keys distinguish DNS lookup options', _t => {
	const agent = new Http2Agent();
	const origin = new URL('https://example.com');
	const firstLookup: LookupFunction = () => {};
	const secondLookup: LookupFunction = () => {};

	assert.strictEqual(
		agent.normalizeOptions(origin, {lookup: firstLookup}),
		agent.normalizeOptions(origin, {lookup: firstLookup}),
	);
	assert.notStrictEqual(
		agent.normalizeOptions(origin, {lookup: firstLookup}),
		agent.normalizeOptions(origin, {lookup: secondLookup}),
	);
	assert.notStrictEqual(
		agent.normalizeOptions(origin, {family: 4}),
		agent.normalizeOptions(origin, {family: 6}),
	);
});

test('passes DNS cache lookup and IP version to native request options', _t => {
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
	assert.deepStrictEqual(lookupArguments, ['example.com', lookupOptions, callback]);
	assert.strictEqual(nativeRequestOptions.family, 6);

	// A custom lookup is wrapped so it can answer the `all` option, so assert that it is used
	// rather than that it is passed through unchanged.
	let explicitLookupCalls = 0;
	options.dnsLookup = (...arguments_) => {
		explicitLookupCalls++;
		Reflect.apply(dnsLookup, undefined, arguments_);
	};

	options.createNativeRequestOptions().lookup!('example.com', {family: 6}, () => {});
	assert.strictEqual(explicitLookupCalls, 1);
});

test('HTTP/2 option on HTTP preserves disabled HTTP agent', _t => {
	const options = new Options('http://example.com', {
		http2: true,
		agent: {
			http: false,
		},
	});

	assert.strictEqual(options.createNativeRequestOptions().agent, false);
});

test('can set defaults to `new Options(...)`', _t => {
	const instance = got.extend({
		mutableDefaults: true,
		followRedirect: false,
	});

	assert.doesNotThrow(() => {
		instance.defaults.options = new Options({
			followRedirect: false,
		}, undefined, instance.defaults.options);
	});

	assert.strictEqual(instance.defaults.options.followRedirect, false);

	assert.doesNotThrow(() => {
		instance.defaults.options = new Options({});
	});

	assert.strictEqual(instance.defaults.options.followRedirect, true);
});

test('can set mutable defaults using got.extend', _t => {
	const instance = got.extend({
		mutableDefaults: true,
		followRedirect: false,
	});

	assert.doesNotThrow(() => {
		instance.defaults.options.followRedirect = true;
	});

	assert.strictEqual(instance.defaults.options.followRedirect, true);
});

test('only plain objects are freezed', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const instance = got.extend({
		agent: {
			http: new HttpAgent({keepAlive: true}),
		},
		mutableDefaults: true,
	});

	assert.doesNotThrow(() => {
		(instance.defaults.options.agent as any).http.keepAlive = true;
	});
});

test('defaults are cloned on instance creation', _t => {
	const options: OptionsInit = {hooks: {beforeRequest: [() => {}]}};
	const instance = got.extend(options);
	const context = {
		foo: {},
	};

	assert.doesNotThrow(() => {
		options.context = context;
		options.hooks!.beforeRequest!.shift();
	});

	assert.notStrictEqual(options.context!.foo, instance.defaults.options.context.foo);
	assert.notStrictEqual(options.hooks!.beforeRequest, instance.defaults.options.hooks.beforeRequest);
});

test('ability to pass a custom request method', withServer, async (_t, server, got) => {
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

	assert.strictEqual(isCalled, true);
});

test('does not include the `request` option in normalized `http` options', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	let isCalled = false;

	const request: RequestFunction = (...arguments_: [
		string | URL | RequestOptions,
		(RequestOptions | ((response: IncomingMessage) => void))?,
		((response: IncomingMessage) => void)?,
	]) => {
		isCalled = true;

		assert.strictEqual(Reflect.has(arguments_[0] as RequestOptions, 'request'), false);

		// @ts-expect-error Overload error
		return httpRequest(...arguments_);
	};

	const instance = got.extend({request});
	await instance('');

	assert.strictEqual(isCalled, true);
});

test('should pass an options object into an initialization hook after .extend', withServer, async (_t, server, got) => {
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

	assert.deepStrictEqual(secondCallOptions, {});
});

test('handlers detect stream mode via `options.isStream`', withServer, async (_t, server, got) => {
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

	assert.strictEqual(promiseModeCount, 1);
	assert.strictEqual(streamModeCount, 1);
});

test('hooks aren\'t overriden when merging options', withServer, async (_t, server, got) => {
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

	assert.strictEqual(isCalled, true);
});

test('extend with custom handlers', withServer, async (_t, server, got) => {
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
	assert.strictEqual(headers.unicorn, 'rainbow');
});

test('extend with instances', _t => {
	const a = got.extend({prefixUrl: new URL('https://example.com/')});
	const b = got.extend(a);
	assert.strictEqual(b.defaults.options.prefixUrl.toString(), 'https://example.com/');
});

test('extend with a chain', _t => {
	const a = got.extend({prefixUrl: 'https://example.com/'});
	const b = got.extend(a, {headers: {foo: 'bar'}});
	assert.strictEqual(b.defaults.options.prefixUrl.toString(), 'https://example.com/');
	assert.strictEqual(b.defaults.options.headers.foo, 'bar');
});

test('async handlers', withServer, async (_t, server, got) => {
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
	assert.strictEqual(is.function(promise.json), true);
	assert.strictEqual(is.function(promise.once), true);

	let responseEventCount = 0;
	const returnedPromise = promise.once('response', () => {
		responseEventCount++;
	});
	assert.strictEqual(returnedPromise, promise);

	// @ts-expect-error Manual tests
	assert.strictEqual((await promise).modified, true);
	assert.strictEqual(responseEventCount, 1);
});

test('async handler upload streams are not retried after being consumed', withServer, async (_t, server, got) => {
	const uploads: string[] = [];
	server.put('/', async (request, response) => {
		uploads.push(await getStream(request));
		response.statusCode = uploads.length === 1 ? 503 : 200;
		response.end('done');
	});
	const client = got.extend({
		handlers: [async (options, next) => {
			await Promise.resolve();
			options.body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('uploaded body'));
					controller.close();
				},
			});
			return next(options);
		}],
	});

	await assert.rejects(client.put('', {retry: {limit: 1, backoffLimit: 0, noise: 0}}), {message: 'Cannot retry with consumed body stream'});
	assert.deepStrictEqual(uploads, ['uploaded body']);
});

for (const bodyType of ['node stream', 'async iterator'] as const) {
	test(`async handler ${bodyType} bodies are not replayed after consumption`, withServer, async (_t, server, got) => {
		const uploads: string[] = [];
		server.put('/', async (request, response) => {
			uploads.push(await getStream(request));
			response.statusCode = uploads.length === 1 ? 503 : 200;
			response.end();
		});
		async function * generate() {
			yield 'uploaded body';
		}

		const client = got.extend({
			handlers: [async (options, next) => {
				await Promise.resolve();
				options.body = bodyType === 'node stream' ? Readable.from(['uploaded body']) : generate();
				return next(options);
			}],
		});

		await assert.rejects(client.put('', {retry: {limit: 1, backoffLimit: 0, noise: 0}}), {message: 'Cannot retry with consumed body stream'});
		assert.deepStrictEqual(uploads, ['uploaded body']);
	});
}

test('beforeRequest stream bodies are not replayed after consumption', withServer, async (_t, server, got) => {
	const uploads: string[] = [];
	server.put('/', async (request, response) => {
		uploads.push(await getStream(request));
		response.statusCode = uploads.length === 1 ? 503 : 200;
		response.end();
	});
	let beforeRequestCalls = 0;
	await assert.rejects(got.put('', {
		body: 'original body',
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRequest: [options => {
				beforeRequestCalls++;
				options.body = Readable.from(['uploaded body']);
			}],
		},
	}), {message: 'Cannot retry with consumed body stream'});

	assert.deepStrictEqual(uploads, ['uploaded body']);
	assert.strictEqual(beforeRequestCalls, 1);
});

test('beforeRetry can replace an async handler stream with a fresh upload', withServer, async (_t, server, got) => {
	const uploads: string[] = [];
	server.put('/', async (request, response) => {
		uploads.push(await getStream(request));
		response.statusCode = uploads.length === 1 ? 503 : 200;
		response.end('done');
	});
	let handlerCalls = 0;
	const client = got.extend({
		handlers: [async (options, next) => {
			handlerCalls++;
			await Promise.resolve();
			options.body = Readable.from(['original body']);
			return next(options);
		}],
	});

	assert.strictEqual(await client.put('', {
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [error => {
				error.options.body = Readable.from(['replacement body']);
			}],
		},
	}).text(), 'done');
	assert.deepStrictEqual(uploads, ['original body', 'replacement body']);
	assert.strictEqual(handlerCalls, 1);
});

test('async handlers can supply replayable bodies for retries', withServer, async (_t, server, got) => {
	const uploads: string[] = [];
	server.put('/', async (request, response) => {
		uploads.push(await getStream(request));
		response.statusCode = uploads.length === 1 ? 503 : 200;
		response.end('done');
	});
	const client = got.extend({
		handlers: [async (options, next) => {
			await Promise.resolve();
			options.body = ['replayable ', 'body'];
			return next(options);
		}],
	});

	assert.strictEqual(await client.put('', {retry: {limit: 1, backoffLimit: 0, noise: 0}}).text(), 'done');
	assert.deepStrictEqual(uploads, ['replayable body', 'replayable body']);
});

test('async handlers can throw', async _t => {
	const message = 'meh';

	const instance = got.extend({
		handlers: [
			async () => {
				throw new Error(message);
			},
		],
	});

	await assert.rejects(instance('https://example.com'), errorMatching(Error, {message}));
});

test('setting dnsCache to true points to global cache', _t => {
	const a = got.extend({
		dnsCache: true,
	});

	const b = got.extend({
		dnsCache: true,
	});

	assert.strictEqual(a.defaults.options.dnsCache, b.defaults.options.dnsCache);
});

test('setting dnsCache to false disables inherited DNS cache', _t => {
	const instance = got.extend({
		dnsCache: true,
	}).extend({
		dnsCache: false,
	});
	const options = new Options('https://example.com', {
		dnsCache: true,
	});
	options.dnsCache = false;

	assert.strictEqual(instance.defaults.options.dnsCache, undefined);
	assert.strictEqual(options.createNativeRequestOptions().lookup, undefined);
});

test('waits for handlers to finish', withServer, async (_t, server, got) => {
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
	assert.strictEqual(foo, 'bar');
});

test('does not leak per-request options into extended defaults', withServer, async (_t, server, got) => {
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

	assert.strictEqual(headers['x-transient'], undefined);
});

test('extend clones searchParams object', _t => {
	const searchParameters = {foo: 'bar', page: '1'};
	const instance = got.extend({searchParams: searchParameters});

	// Mutate the original
	searchParameters.foo = 'changed';
	searchParameters.page = '999';

	// Instance should have the original values (converted to URLSearchParams)
	const instanceParameters = instance.defaults.options.searchParams;
	assert.strictEqual(instanceParameters.get('foo'), 'bar');
	assert.strictEqual(instanceParameters.get('page'), '1');
});

test('extend clones URLSearchParams instance', _t => {
	const searchParameters = new URLSearchParams({foo: 'bar', page: '1'});
	const instance = got.extend({searchParams: searchParameters});

	// Mutate the original
	searchParameters.set('foo', 'changed');
	searchParameters.set('page', '999');

	// Instance should have the original values
	const instanceParameters = instance.defaults.options.searchParams;
	assert.strictEqual(instanceParameters.get('foo'), 'bar');
	assert.strictEqual(instanceParameters.get('page'), '1');
	assert.notStrictEqual(instanceParameters, searchParameters);
});

test('extend handles string searchParams', _t => {
	const searchParameters = 'foo=bar&page=1';
	const instance = got.extend({searchParams: searchParameters});

	// String gets converted to URLSearchParams
	const instanceParameters = instance.defaults.options.searchParams;
	assert.strictEqual(instanceParameters.get('foo'), 'bar');
	assert.strictEqual(instanceParameters.get('page'), '1');
});

test('extended instances carry searchParams', _t => {
	const instanceA = got.extend({
		searchParams: {foo: 'bar'},
	});

	const instanceB = instanceA.extend({
		searchParams: {page: '1'},
	});

	const instanceParametersB = instanceB.defaults.options.searchParams;
	assert.strictEqual(instanceParametersB.get('foo'), 'bar');
	assert.strictEqual(instanceParametersB.get('page'), '1');
});

test('extend creates independent searchParams copies', _t => {
	const searchParameters = {foo: 'bar'};
	const instanceA = got.extend({searchParams: searchParameters, mutableDefaults: true});
	const instanceB = got.extend({searchParams: searchParameters, mutableDefaults: true});

	// Modify instanceA's searchParams
	instanceA.defaults.options.searchParams.set('foo', 'modified');

	// InstanceB should be unaffected
	assert.strictEqual(instanceB.defaults.options.searchParams.get('foo'), 'bar');
});

test('got.extend() with responseType works at runtime', withServer, async (_t, server) => {
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
	assert.deepStrictEqual(jsonResponse.body, {data: 'test'});

	// Test responseType: 'buffer' works
	const bufferClient = got.extend({
		prefixUrl: server.url,
		responseType: 'buffer',
	});

	const bufferResponse = await bufferClient('buffer');
	assert.strictEqual(bufferResponse.body instanceof Uint8Array, true);
	assert.strictEqual(Buffer.isBuffer(bufferResponse.body), false);
	assert.strictEqual(Buffer.from(bufferResponse.body).toString(), 'binary');

	// Test resolveBodyOnly works with extended responseType
	const jsonBodyClient = got.extend({
		prefixUrl: server.url,
		responseType: 'json',
		resolveBodyOnly: true,
	});

	const jsonBody = await jsonBodyClient('json');
	assert.deepStrictEqual(jsonBody, {data: 'test'});
});

test('extend preserves an explicit mutableDefaults setting across later options', _t => {
	const instance = got.extend({mutableDefaults: true}, {headers: {'x-test': 'original'}});

	assert.strictEqual(instance.defaults.mutableDefaults, true);
	instance.defaults.options.headers['x-test'] = 'updated';
	assert.strictEqual(instance.defaults.options.headers['x-test'], 'updated');
});

for (const mutableDefaults of [true, false]) {
	test(`extend retains explicit mutableDefaults ${mutableDefaults} through omitted values`, _t => {
		const instance = got.extend({mutableDefaults: !mutableDefaults}, {mutableDefaults}, {}, {mutableDefaults: undefined});

		assert.strictEqual(instance.defaults.mutableDefaults, mutableDefaults);
		assert.strictEqual(Object.isFrozen(instance.defaults.options.headers), !mutableDefaults);
	});
}

test('immutable defaults freeze every hook array', _t => {
	const {hooks} = got.extend({mutableDefaults: false}).defaults.options;

	for (const [event, handlers] of Object.entries(hooks)) {
		assert.strictEqual(Object.isFrozen(handlers), true, event);
	}
});

test('extend retains merged instance mutability through later options', _t => {
	const mutableInstance = got.extend({mutableDefaults: true});
	const instance = got.extend(mutableInstance, {headers: {'x-test': 'original'}});

	assert.strictEqual(instance.defaults.mutableDefaults, true);
	instance.defaults.options.headers['x-test'] = 'updated';
	assert.strictEqual(instance.defaults.options.headers['x-test'], 'updated');
	assert.strictEqual(mutableInstance.defaults.options.headers['x-test'], undefined);
});

test('extend on an instance retains its mutability through later options', _t => {
	const mutableInstance = got.extend({mutableDefaults: true});
	const instance = mutableInstance.extend({headers: {'x-test': 'original'}});

	assert.strictEqual(instance.defaults.mutableDefaults, true);
	instance.defaults.options.headers['x-test'] = 'updated';
	assert.strictEqual(instance.defaults.options.headers['x-test'], 'updated');
	assert.strictEqual(mutableInstance.defaults.options.headers['x-test'], undefined);
});

test('extend on an instance retains its mutability with no options', _t => {
	const mutableInstance = got.extend({mutableDefaults: true});

	assert.strictEqual(mutableInstance.extend().defaults.mutableDefaults, true);
});

test('extend allows later instances to override explicit mutability', _t => {
	const mutableInstance = got.extend({mutableDefaults: true});
	const frozenInstance = got.extend({mutableDefaults: false});

	assert.strictEqual(got.extend({mutableDefaults: false}, mutableInstance, {}).defaults.mutableDefaults, true);
	assert.strictEqual(got.extend({mutableDefaults: true}, frozenInstance, {}).defaults.mutableDefaults, false);
});

test('chained instances preserve inherited response defaults', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});

	const parent = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const child = parent.extend({headers: {'x-test': 'yes'}}).extend();

	assert.deepStrictEqual(await child(''), new Uint8Array(Buffer.from('hello')));
	assert.strictEqual(await child.extend({responseType: 'text'})(''), 'hello');
	assert.deepStrictEqual((await child.extend({resolveBodyOnly: false})('')).body, new Uint8Array(Buffer.from('hello')));
});

test('extend merges arrays of configuration layers in order', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});

	const layers = [{headers: {'x-first': 'one'}}, {headers: {'x-second': 'two'}}];
	const parent = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const child = parent.extend(...layers);

	assert.deepStrictEqual(await child(''), new Uint8Array(Buffer.from('hello')));
	assert.strictEqual(child.defaults.options.headers['x-first'], 'one');
	assert.strictEqual(child.defaults.options.headers['x-second'], 'two');
	assert.strictEqual(await parent.extend(...layers, {responseType: 'text'})(''), 'hello');
});

test('undefined response defaults do not override parent instances', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});

	const parent = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const child = parent.extend({responseType: undefined, resolveBodyOnly: undefined});

	assert.deepStrictEqual(await child(''), new Uint8Array(Buffer.from('hello')));
	assert.strictEqual(child.defaults.options.responseType, 'buffer');
	assert.strictEqual(child.defaults.options.resolveBodyOnly, true);
	assert.strictEqual((await child.extend({responseType: 'text', resolveBodyOnly: false})('')).body, 'hello');
});

for (const responseType of ['text', 'buffer'] as const) {
	for (const resolveBodyOnly of [true, false]) {
		test(`dynamic defaults return ${responseType} with body-only ${resolveBodyOnly}`, withServer, async (_t, server, got) => {
			server.get('/', (_request, response) => {
				response.end('hello');
			});

			const client = got.extend({responseType, resolveBodyOnly});
			const response = await client('');
			const expectedBody = responseType === 'buffer' ? new Uint8Array(Buffer.from('hello')) : 'hello';

			if (resolveBodyOnly) {
				assert.deepStrictEqual(response, expectedBody);
			} else {
				assert.partialDeepStrictEqual(response, {statusCode: 200});
				assert.deepStrictEqual((response as Response).body, expectedBody);
			}
		});
	}
}

test('immutable defaults cannot be replaced', _t => {
	const client = got.extend({headers: {'x-test': 'original'}});

	assert.throws(() => {
		client.defaults.options = new Options({headers: {'x-test': 'replacement'}});
	}, TypeError);
	assert.strictEqual(client.defaults.options.headers['x-test'], 'original');
});

test('immutable handler defaults cannot be replaced or deleted', _t => {
	const client = got.extend();
	const {handlers} = client.defaults;

	assert.throws(() => {
		client.defaults.handlers = [];
	}, TypeError);
	assert.strictEqual(Reflect.deleteProperty(client.defaults, 'handlers'), false);
	assert.strictEqual(Reflect.deleteProperty(client.defaults, 'options'), false);
	assert.strictEqual(client.defaults.handlers, handlers);
});

test('mutable instances can replace options and handlers used by requests', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.json([request.headers['x-options'], request.headers['x-handler']]);
	});

	const client = got.extend({mutableDefaults: true});
	client.defaults.options = new Options({headers: {'x-options': 'replacement'}}, undefined, client.defaults.options);
	client.defaults.handlers = [(options, next) => {
		options.headers['x-handler'] = 'replacement';
		return next(options);
	}];

	assert.deepStrictEqual(await client('').json(), ['replacement', 'replacement']);
});

test('extending an instance creates an independent defaults container', _t => {
	const parent = got.extend({mutableDefaults: true});
	const child = parent.extend();

	// `parent.extend()` is `got.extend(parent)`, so the child inherits the parent's mutability.
	assert.strictEqual(child.defaults.mutableDefaults, true);
	assert.strictEqual(Object.isFrozen(parent.defaults), false);
	parent.defaults.options = new Options({headers: {'x-parent': 'changed'}});
	assert.strictEqual(child.defaults.options.headers['x-parent'], undefined);
});

for (const mutableDefaults of [true, false]) {
	test(`default bindings remain read-only with mutableDefaults ${mutableDefaults}`, _t => {
		const client = got.extend({mutableDefaults});
		const {defaults} = client;

		assert.strictEqual(Reflect.set(client, 'defaults', got.defaults), false);
		assert.strictEqual(Reflect.set(defaults, 'mutableDefaults', !mutableDefaults), false);
		assert.strictEqual(Reflect.deleteProperty(client, 'defaults'), false);
		assert.strictEqual(Reflect.deleteProperty(defaults, 'mutableDefaults'), false);
		assert.strictEqual(client.defaults, defaults);
		assert.strictEqual(client.defaults.mutableDefaults, mutableDefaults);
	});
}

test('undefined request options preserve inherited response defaults', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hello');
	});
	const client = got.extend({responseType: 'buffer', resolveBodyOnly: true});
	const expected = new Uint8Array(Buffer.from('hello'));

	assert.deepStrictEqual(await client('', {responseType: undefined}), expected);
	assert.deepStrictEqual(await client({resolveBodyOnly: undefined}), expected);
	assert.deepStrictEqual(await client.get('', {responseType: undefined, resolveBodyOnly: undefined}), expected);
	assert.deepStrictEqual((await client('', {responseType: undefined, resolveBodyOnly: false})).body, expected);
	assert.strictEqual(await client({responseType: 'text', resolveBodyOnly: undefined}), 'hello');
});

test('undefined request responseType preserves JSON parsing and wrapped responses', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.json({value: 1});
	});
	const client = got.extend({responseType: 'json'});

	assert.deepStrictEqual((await client.post({responseType: undefined, resolveBodyOnly: undefined})).body, {value: 1});
	assert.deepStrictEqual(await client.post('', {responseType: undefined, resolveBodyOnly: true}), {value: 1});
});

test('handler-supplied stream body failures are upload errors', withServer, async (_t, server, got) => {
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

	const error = await rejects(client.post('', {retry: {limit: 0}, timeout: {request: 10_000}}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
});

test('beforeRequest replacement stream errors do not trigger network retries', withServer, async (_t, server, got) => {
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

	const error = await rejects(got.post('', {
		body: 'original',
		timeout: {request: 10_000},
		retry: {limit: 1, methods: ['POST'], calculateDelay: () => 1},
		hooks: {
			beforeRequest: [options => {
				options.body = body;
			}],
			beforeRetry: [() => {
				retries++;
			}],
		},
	}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(retries, 0);
});

test('handler-supplied body failures reach the streaming API', withServer, async (_t, server, got) => {
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

	const error = await rejects(getStream(client.stream.post('', {timeout: {request: 10_000}})), errorMatching(UploadError, {code: 'ERR_UPLOAD'}));

	assert.strictEqual(error.cause, cause);
});

test('initial body errors remain handled before asynchronous handlers finish', withServer, async (_t, _server, got) => {
	const cause = new Error('Initial body failed');
	const body = new Readable({read() {}});
	const client = got.extend({
		handlers: [async (options, next) => {
			body.destroy(cause);
			await delay(10);
			return next(options);
		}],
	});

	const error = await rejects(client.post('', {body}), errorMatching(UploadError, {code: 'ERR_UPLOAD'}));

	assert.strictEqual(error.cause, cause);
});

test('initial stream uploads retain exactly one Got error listener', withServer, async (_t, server, got) => {
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

	assert.strictEqual(await got.post('', {body}).text(), 'payload');
	assert.strictEqual(errorListeners, 1);
});

// `Options` keeps its state private, so a handler that hands `next()` anything but the
// instance it was given loses them, and the request fails later with an unrelated error.
type NextArgument = Options | Record<string, unknown> | undefined;

for (const [name, forward] of [
	['a spread copy', (options: Options): NextArgument => ({...options})],
	['nothing', (): NextArgument => undefined],
	['a plain object', (): NextArgument => ({})],
] as Array<[string, (options: Options) => NextArgument]>) {
	test(`a handler that passes ${name} to next is rejected`, withServer, async (_t, _server, got) => {
		const instance = got.extend({
			handlers: [
				(options, next) => next(forward(options) as Options),
			],
		});

		// The handler chain throws before the request is dispatched, so no server is needed.
		assert.throws(() => instance(''), errorMatching(TypeError, {message: 'The `next()` function of a handler must be called with the `options` object it received'}));
	});
}

// A rejected input is reported by the request itself, so the handler chain must keep running.
test('the handler chain runs when the input was rejected', async _t => {
	const instance = got.extend({
		handlers: [
			(_options, next) => next(undefined as unknown as Options),
		],
	});

	const rejectedInput: unknown = false;
	await assert.rejects(instance(rejectedInput as never), errorMatching(Error, {message: /Option 'input'/v}));
});

test('extend rejects non-function handlers', _t => {
	assert.throws(() => got.extend({handlers: ['not a function' as any]}), (error: Error) => {
		assert.strictEqual(error instanceof TypeError, true);
		assert.match(error.message, /handlers\[0\]/v);
		return true;
	});
});

test('extend rejects null handlers instead of skipping them', _t => {
	assert.throws(() => got.extend({handlers: [null as any]}), TypeError);
});

test('a handler can answer without calling next', withServer, async (_t, server) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		response.end('network');
	});

	const instance = got.extend({
		prefixUrl: server.url,
		handlers: [
			async (options, next) => options.headers['x-cached'] === 'yes' ? 'cached' as never : next(options),
		],
	});

	assert.strictEqual(await instance('', {headers: {'x-cached': 'yes'}}), 'cached');
	assert.strictEqual(requestCount, 0);

	assert.strictEqual((await instance('')).body, 'network');
	assert.strictEqual(requestCount, 1);
});

test('an error replaced by a handler is final and comes after the beforeError hooks', withServer, async (_t, server) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const events: string[] = [];
	const replacement = new Error('Replaced by the handler');
	const instance = got.extend({
		prefixUrl: server.url,
		retry: {
			limit: 0,
		},
		hooks: {
			beforeError: [error => {
				events.push(`beforeError ${error.name}`);
				return error;
			}],
		},
		handlers: [
			async (options, next) => {
				try {
					return await next(options);
				} catch (error) {
					events.push(`handler ${(error as Error).name}`);
					throw replacement;
				}
			},
		],
	});

	const error = await rejects(instance(''));

	assert.strictEqual(error, replacement);
	assert.deepStrictEqual(events, ['beforeError HTTPError', 'handler HTTPError']);
});

test('an empty hook array in the request options keeps the instance hooks', withServer, async (_t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let calls = 0;
	const instance = got.extend({
		prefixUrl: server.url,
		hooks: {
			beforeRequest: [() => {
				calls++;
			}],
		},
	});

	await instance('', {hooks: {beforeRequest: []}});

	assert.strictEqual(calls, 1);
	assert.strictEqual(instance.defaults.options.hooks.beforeRequest.length, 1);
});

test('an afterResponse hook can refresh mutable defaults and retry', withServer, async (_t, server) => {
	const receivedTokens: Array<string | undefined> = [];
	server.get('/', (request, response) => {
		const token = request.headers.token as string | undefined;
		receivedTokens.push(token);
		response.statusCode = token === 'fresh' ? 200 : 401;
		response.end();
	});

	let refreshCount = 0;
	const instance = got.extend({
		prefixUrl: server.url,
		headers: {
			token: 'stale',
		},
		mutableDefaults: true,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode !== 401) {
						return response;
					}

					refreshCount++;
					const updatedOptions = {headers: {token: 'fresh'}};
					instance.defaults.options.merge(updatedOptions);
					return retryWithMergedOptions(updatedOptions);
				},
			],
		},
	});

	assert.strictEqual((await instance('')).statusCode, 200);
	assert.strictEqual((await instance('')).statusCode, 200);

	assert.strictEqual(refreshCount, 1);
	assert.deepStrictEqual(receivedTokens, ['stale', 'fresh', 'fresh']);
});

test('immutable defaults reject a merge of a scalar option', _t => {
	const instance = got.extend({maxRedirects: 5});

	assert.throws(() => {
		instance.defaults.options.merge({maxRedirects: 3});
	}, TypeError);
	assert.strictEqual(instance.defaults.options.maxRedirects, 5);
});

// Suspected bug: merging `maxRedirects` or `hooks` into frozen defaults throws, but `headers` and `timeout` go through `Reflect.set` and are dropped without an error.
test.failing('immutable defaults reject a merge of headers like other options', _t => {
	const instance = got.extend({headers: {token: 'original'}});

	assert.throws(() => {
		instance.defaults.options.merge({headers: {token: 'changed'}});
	}, TypeError);
	assert.strictEqual(instance.defaults.options.headers.token, 'original');
});

// Suspected bug: the dropped merge still marks the header as explicit, which `failed header writes on frozen defaults do not mark headers as explicit` rules out for direct writes.
test.failing('a header merge dropped by immutable defaults does not mark the header as explicit', _t => {
	const instance = got.extend({headers: {token: 'original'}});

	try {
		instance.defaults.options.merge({headers: {authorization: 'Bearer secret'}});
	} catch {}

	assert.strictEqual(instance.defaults.options.headers.authorization, undefined);
	assert.strictEqual(instance.defaults.options.isHeaderExplicitlySet('authorization'), false);
});
