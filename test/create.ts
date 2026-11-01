import {Readable} from 'node:stream';
import process from 'node:process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Buffer} from 'node:buffer';
import {
	Agent as HttpAgent,
	get as httpGet,
	request as httpRequest,
	type IncomingMessage,
	type RequestOptions,
} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import type {LookupFunction} from 'node:net';
import tls from 'node:tls';
import {setImmediate} from 'node:timers/promises';
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
	type RequestPromise,
	type HandlerFunction,
	type ExtendOptions,
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

test('cached custom request functions receive the documented URL, options, and callback', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end(`${request.url}:${String(request.headers['x-custom'])}`);
	});
	let calls = 0;
	const client = got.extend({
		cache: new Map(),
		request(url, options, callback) {
			calls++;
			assert.ok(url instanceof URL);
			assert.strictEqual(url.href, `${server.url}/?a=1&b=2`);
			assert.strictEqual(options.path, '/?a=1&b=2');
			assert.strictEqual(typeof callback, 'function');
			Reflect.set(options.headers!, 'x-custom', 'present');
			return httpRequest(url, options, callback);
		},
	});
	const first = await client('?a=1&b=2');
	const second = await client('?a=1&b=2');
	assert.strictEqual(first.body, '/?a=1&b=2:present');
	assert.strictEqual(second.body, first.body);
	assert.strictEqual(second.isFromCache, true);
	assert.strictEqual(first.request.options.headers['x-custom'], undefined);
	assert.strictEqual(calls, 1);
});

test('replacement handler settlement releases the active retry attempt', withServer, async (_t, server) => {
	server.get('/cached', (_request, response) => {
		response.end('cached response');
	});
	const retried = new Set<string>();
	server.get('/resource', (request, response) => {
		if (!retried.has(request.originalUrl)) {
			retried.add(request.originalUrl);
			response.status(503).end('retry');
		}
	});
	const script = `
		import assert from 'node:assert/strict';
		import {setImmediate} from 'node:timers/promises';
		import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
		const cached = await got(process.argv[1] + '/cached');
		for (const rejectReplacement of [false, true]) {
			let activeRequest;
			let attempts = 0;
			const cause = new Error('Replacement failed after retry');
			const client = got.extend({handlers: [(options, next) => {
				const result = next(options);
				result.catch(() => {});
				return new Promise((resolve, reject) => {
					result.on('request', request => {
						if (++attempts === 2) {
							activeRequest = request;
							if (rejectReplacement) {
								reject(cause);
							} else {
								resolve(cached);
							}
						}
					});
				});
			}]});
			try {
				const result = client(process.argv[1] + '/resource?reject=' + rejectReplacement, {retry: {limit: 1, backoffLimit: 0, noise: 0}});
				if (rejectReplacement) {
					await assert.rejects(result, error => error === cause);
				} else {
					assert.strictEqual(await result, cached);
				}
				await setImmediate();
				assert.strictEqual(activeRequest.destroyed, true);
			} finally {
				activeRequest?.destroy();
			}
		}
	`;
	await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url], {timeout: 15_000});
});

test('a fulfilled replacement handler releases the undispatched upload it owns', withServer, async (_t, server) => {
	server.get('/', (_request, response) => {
		response.end('cached response');
	});
	const script = `
		import assert from 'node:assert/strict';
		import {Readable} from 'node:stream';
		import {setImmediate} from 'node:timers/promises';
		import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
		const cached = got(process.argv[1]);
		const expected = await cached;
		const customShortcut = () => 'custom shortcut';
		Object.defineProperty(cached, 'customShortcut', {value: customShortcut});
		let reads = 0;
		const upload = new Readable({read() {reads++;}});
		const client = got.extend({handlers: [() => cached]});
		const request = client.post(process.argv[1], {body: upload});
		assert.strictEqual(await request, expected);
		await setImmediate();
		assert.strictEqual(reads, 0);
		assert.strictEqual(upload.destroyed, true);
		assert.strictEqual(await request.text(), 'cached response');
		assert.strictEqual(request.customShortcut, customShortcut);

		const pending = Promise.withResolvers();
		const pendingBody = new Readable({read() {}});
		const delayed = got.extend({handlers: [() => pending.promise]});
		const delayedRequest = delayed.post(process.argv[1], {body: pendingBody});
		assert.strictEqual(pendingBody.destroyed, false);
		pending.resolve(expected);
		assert.strictEqual(await delayedRequest, expected);
		assert.strictEqual(pendingBody.destroyed, true);

		let cancellations = 0;
		const webBody = new ReadableStream({cancel() {cancellations++;}});
		assert.strictEqual(await client.post(process.argv[1], {body: webBody}), expected);
		assert.strictEqual(cancellations, 1);
		assert.strictEqual(webBody.locked, false);

		const original = new Readable({read() {}});
		const callerListener = () => {};
		original.on('error', callerListener);
		const cleanupError = new Error('Replacement cleanup failed');
		const replacement = new Readable({read() {}, destroy(_error, callback) {callback(cleanupError);}});
		const cleanupErrors = [];
		replacement.on('error', error => {cleanupErrors.push(error);});
		const replacing = got.extend({handlers: [async options => {
			await Promise.resolve();
			options.body = replacement;
			return cached;
		}]});
		assert.strictEqual(await replacing.post(process.argv[1], {body: original}), expected);
		await setImmediate();
		assert.strictEqual(original.destroyed, false);
		assert.deepStrictEqual(original.listeners('error'), [callerListener]);
		assert.strictEqual(replacement.destroyed, true);
		assert.deepStrictEqual(cleanupErrors, [cleanupError]);
		original.destroy();

		const recoverable = new Error('Recoverable handler failure');
		const recoveredBody = new Readable({read() {}});
		const recovering = got.extend({handlers: [async (options, next) => {
			try {
				return await next(options);
			} catch (error) {
				assert.strictEqual(error, recoverable);
				assert.strictEqual(recoveredBody.destroyed, false);
				return cached;
			}
		}, () => {throw recoverable;}]});
		assert.strictEqual(await recovering.post(process.argv[1], {body: recoveredBody}), expected);
		assert.strictEqual(recoveredBody.destroyed, true);
	`;
	await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url]);
});

for (const automaticallyEnded of [false, true]) {
	test(`custom requests can return a ClientRequest ended ${automaticallyEnded ? 'by http.get' : 'explicitly'}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('completed request');
		});
		let requestEvents = 0;
		const uploads: Array<{percent: number; transferred: number}> = [];
		const response = await got('', {
			retry: {limit: 0},
			request(url, options) {
				if (automaticallyEnded) {
					return httpGet(url, options);
				}

				const request = httpRequest(url, options);
				request.end();
				return request;
			},
		}).on('request', request => {
			requestEvents++;
			assert.strictEqual(request.writableEnded, true);
		}).on('uploadProgress', progress => {
			uploads.push(progress);
		});
		assert.strictEqual(response.body, 'completed request');
		assert.strictEqual(requestEvents, 1);
		assert.strictEqual(response.request.writableFinished, true);
		assert.strictEqual(uploads.filter(progress => progress.percent === 1).length, 1);
		assert.strictEqual(uploads.every(progress => progress.transferred === 0), true);
	});
}

test('asynchronous custom request functions can resolve to an ended native request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('async request');
	});
	assert.strictEqual(await got('', {
		async request(url, options) {
			return httpGet(url, options);
		},
	}).text(), 'async request');
});

test('beforeRequest can return an ended native request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('hook request');
	});
	assert.strictEqual(await got('', {
		hooks: {
			beforeRequest: [options => httpGet(options.url!, {headers: options.headers})],
		},
	}).text(), 'hook request');
});

test('redirects can adopt ended native GET requests after a configured upload', withServer, async (_t, server, got) => {
	const requests: Array<{method: string; body: string}> = [];
	server.post('/start', async (request, response) => {
		requests.push({method: request.method, body: await getStream(request)});
		response.writeHead(303, {location: '/next'}).end();
	});
	server.get('/next', async (request, response) => {
		requests.push({method: request.method, body: await getStream(request)});
		response.writeHead(307, {location: '/finish'}).end();
	});
	server.get('/finish', async (request, response) => {
		requests.push({method: request.method, body: await getStream(request)});
		response.end('redirected request');
	});
	const response = await got.post('start', {
		body: 'original upload',
		request(url, options) {
			return options.method === 'GET' ? httpGet(url, options) : httpRequest(url, options);
		},
	});
	assert.strictEqual(response.body, 'redirected request');
	assert.deepStrictEqual(requests, [{method: 'POST', body: 'original upload'}, {method: 'GET', body: ''}, {method: 'GET', body: ''}]);
	assert.deepStrictEqual(response.redirectUrls.map(url => url.pathname), ['/next', '/finish']);
});

test('ended custom requests retain native error ownership without an unhandled error', withServer, async (_t, server) => {
	server.get('/', (request, _response) => {
		request.socket.destroy();
	});
	const script = `
		import assert from 'node:assert/strict';
		import {get} from 'node:http';
		import {setImmediate} from 'node:timers/promises';
		import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
		await assert.rejects(got(process.argv[1], {request: get, retry: {limit: 0}}), {code: 'ECONNRESET'});
		await setImmediate();
		await setImmediate();
	`;
	await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url]);
});

test('handler cleanup preserves settlement with the documented global Bluebird promise', withServer, async (_t, server) => {
	server.get('/', (_request, response) => {
		response.end('bluebird response');
	});
	const script = `
		import assert from 'node:assert/strict';
		import Bluebird from 'bluebird';
		import {Readable} from 'node:stream';
		import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
		globalThis.Promise = Bluebird;
		let handlerCompletions = 0;
		const client = got.extend({handlers: [(options, next) => {
			const result = next(options).then(response => response);
			result.then(() => {handlerCompletions++;});
			return result;
		}]});
		assert.strictEqual(await client(process.argv[1]).text(), 'bluebird response');
		assert.strictEqual(handlerCompletions, 1);
		const cause = new Error('bluebird handler failure');
		const failing = got.extend({handlers: [(options, next) => next(options).then(() => {throw cause;})]});
		await assert.rejects(failing(process.argv[1]).text(), error => error === cause);
		const cached = got(process.argv[1]);
		const expected = await cached;
		const upload = new Readable({read() {}});
		const shortCircuit = got.extend({handlers: [() => cached]});
		assert.strictEqual(await shortCircuit.post(process.argv[1], {body: upload}), expected);
		assert.strictEqual(upload.destroyed, true);
	`;
	await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url], {timeout: 15_000});
});

for (const customHandler of [false, true]) {
	test(`ignored ${customHandler ? 'handler' : 'native request'} failures retain native unhandled rejection reporting`, async _t => {
		const script = `
			import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
			got.extend({handlers: ${customHandler ? '[async () => {throw new Error("Unhandled request failure");}]' : '[]'}})('http://localhost/', {
				retry: {limit: 0},
				request() {throw new Error('Unhandled request failure');},
			});
		`;
		await assert.rejects(promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script]), error => {
			assert.match((error as Error & {stderr: string}).stderr, /Unhandled request failure/v);
			return true;
		});
	});
}

for (const asynchronous of [false, true]) {
	test(`${asynchronous ? 'asynchronous' : 'synchronous'} handler failures release the undispatched upload body`, async _t => {
		const cause = new Error('Handler failed before dispatch');
		let dispatches = 0;
		let destroys = 0;
		const body = new Readable({
			read() {},
			destroy(error, callback) {
				destroys++;
				callback(error);
			},
		});
		const callerListener = () => {};
		body.on('error', callerListener);
		const fail = () => {
			throw cause;
		};

		const client = got.extend({
			request() {
				dispatches++;
				throw new Error('Unexpected dispatch');
			},
			handlers: [asynchronous ? async () => fail() : fail],
		});
		if (asynchronous) {
			await assert.rejects(client.post('http://localhost/', {body}), error => error === cause);
		} else {
			assert.throws(() => client.post('http://localhost/', {body}), error => error === cause);
		}

		await setImmediate();
		assert.strictEqual(body.destroyed, true);
		assert.strictEqual(destroys, 1);
		assert.strictEqual(dispatches, 0);
		assert.ok(body.listeners('error').includes(callerListener));
	});
}

test('synchronous stream handler failures release their upload body', async _t => {
	const cause = new Error('Stream handler failed');
	const body = new Readable({read() {}});
	const client = got.extend({
		handlers: [() => {
			throw cause;
		}],
	});

	assert.throws(() => client.stream.post('http://localhost/', {body}), error => error === cause);
	await setImmediate();
	assert.strictEqual(body.destroyed, true);
});

test('handler failure cleanup retains existing shortcut methods on its returned promise', async _t => {
	const cause = new Error('Handler promise failed');
	const result = Promise.withResolvers<never>();
	const customJson = async () => 'custom shortcut';
	void Object.defineProperty(result.promise, 'json', {value: customJson});
	const body = new Readable({read() {}});
	const client = got.extend({handlers: [() => result.promise]});
	const response = client.post('http://localhost/', {body});
	assert.notStrictEqual(response, result.promise);
	assert.strictEqual(response.json, customJson);
	assert.strictEqual(typeof response.text, 'function');
	const text = response.text();
	result.reject(cause);
	await Promise.all([
		assert.rejects(response, error => error === cause),
		assert.rejects(text, error => error === cause),
	]);
	assert.strictEqual(body.destroyed, true);
});

test('an outer handler can recover an inner handler failure and dispatch the upload', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	const cause = new Error('Recoverable handler failure');
	const body = Readable.from(['recovered upload']);
	const recover: HandlerFunction = async (options, next) => {
		await assert.rejects(Promise.resolve(next(options)), error => error === cause);
		assert.strictEqual(body.destroyed, false);
		return next(options);
	};

	const client = got.extend({
		handlers: [
			recover,
			async () => {
				throw cause;
			},
		],
	});

	assert.strictEqual(await client.post('', {body}).text(), 'recovered upload');
});

test('a handler rejection after dispatch releases the native request and keeps its error', withServer, async (_t, _server, got) => {
	const cause = new Error('Handler failed after dispatch');
	const body = new Readable({read() {}});
	const dispatched = Promise.withResolvers<void>();
	let dispatchedRequest: ReturnType<typeof httpRequest> | undefined;
	let errorHookCalls = 0;
	const client = got.extend({
		hooks: {
			beforeError: [error => {
				errorHookCalls++;
				return error;
			}],
		},
		handlers: [async (options, next) => {
			void (next(options) as RequestPromise).on('request', request => {
				dispatchedRequest = request;
				dispatched.resolve();
			});
			await dispatched.promise;
			throw cause;
		}],
	});

	await assert.rejects(client.post('', {body}), error => error === cause);
	await setImmediate();
	assert.ok(dispatchedRequest);
	assert.strictEqual(dispatchedRequest.destroyed, true);
	assert.strictEqual(body.destroyed, true);
	assert.strictEqual(errorHookCalls, 0);
});

test('a rejected handler releases its replacement body without replacing the handler error', async t => {
	const cause = new Error('Handler failed after replacing its body');
	const cleanupError = new Error('Replacement cleanup failed');
	const original = new Readable({read() {}});
	const replacement = new Readable({
		read() {},
		destroy(_error, callback) {
			callback(cleanupError);
		},
	});
	const cleanupErrors: Error[] = [];
	const callerListener = () => {};
	original.on('error', callerListener);
	replacement.on('error', error => {
		cleanupErrors.push(error);
	});
	t.after(() => {
		original.destroy();
	});
	const client = got.extend({
		handlers: [async options => {
			await Promise.resolve();
			options.body = replacement;
			throw cause;
		}],
	});

	await assert.rejects(client.post('http://localhost/', {body: original}), error => error === cause);
	await setImmediate();
	assert.strictEqual(replacement.destroyed, true);
	assert.deepStrictEqual(cleanupErrors, [cleanupError]);
	assert.strictEqual(original.destroyed, false);
	assert.deepStrictEqual(original.listeners('error'), [callerListener]);
});

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
		arguments_[2](null, '::1', 6);
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
	const callbackArguments: unknown[][] = [];

	const callback: Parameters<LookupFunction>[2] = (...arguments_) => {
		callbackArguments.push(arguments_);
	};

	nativeRequestOptions.lookup!('example.com', lookupOptions, callback);
	assert.deepStrictEqual(lookupArguments?.slice(0, 2), ['example.com', lookupOptions]);
	assert.deepStrictEqual(callbackArguments, [[null, '::1', 6]]);
	assert.strictEqual(options.createNativeRequestOptions().lookup, nativeRequestOptions.lookup);
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

test('extend captures the handlers getter once before validating and installing handlers', _t => {
	let reads = 0;
	const handler: HandlerFunction = (options, next) => next(options);
	const instance = got.extend({
		get handlers() {
			reads++;
			return [reads < 4 ? handler : 42 as unknown as HandlerFunction];
		},
	});
	assert.deepStrictEqual(instance.defaults.handlers, [handler]);
	assert.strictEqual(reads, 1);
});

test('extend captures the mutableDefaults getter once', _t => {
	let reads = 0;
	const instance = got.extend({
		get mutableDefaults() {
			reads++;
			return reads === 1;
		},
	});
	assert.strictEqual(reads, 1);
	assert.strictEqual(instance.defaults.mutableDefaults, true);
});

for (const inherited of [false, true]) {
	test(`extend captures ${inherited ? 'inherited' : 'non-enumerable'} control getters once`, _t => {
		let handlerReads = 0;
		let mutableDefaultsReads = 0;
		const handler: HandlerFunction = (options, next) => next(options);
		const controls = Object.defineProperties({}, {
			handlers: {
				get() {
					handlerReads++;
					return [handler];
				},
			},
			mutableDefaults: {
				get() {
					mutableDefaultsReads++;
					return true;
				},
			},
		}) as ExtendOptions;
		const instance = got.extend(inherited ? Object.create(controls) as ExtendOptions : controls);
		assert.deepStrictEqual(instance.defaults.handlers, [handler]);
		assert.strictEqual(instance.defaults.mutableDefaults, true);
		assert.strictEqual(handlerReads, 1);
		assert.strictEqual(mutableDefaultsReads, 1);
	});
}

test('extension snapshots retain hidden nested options and custom init-hook options', _t => {
	const extensionOptions = Object.defineProperty({
		custom: 'kept',
		hooks: {
			init: [(raw: OptionsInit, options: Options) => {
				options.context.custom = Reflect.get(raw, 'custom');
				Reflect.deleteProperty(raw, 'custom');
			}],
		},
	}, 'context', {value: {hidden: true}});
	const instance = got.extend(extensionOptions);
	assert.deepStrictEqual(instance.defaults.options.context, {custom: 'kept', hidden: true});
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

// Headers and timeout use Reflect.set internally, which must not hide a failed immutable merge.
test('immutable defaults reject a merge of headers like other options', _t => {
	const instance = got.extend({headers: {token: 'original'}});

	assert.throws(() => {
		instance.defaults.options.merge({headers: {token: 'changed'}});
	}, TypeError);
	assert.strictEqual(instance.defaults.options.headers.token, 'original');
});

// A failed immutable merge must not change the metadata used for credential forwarding.
test('a header merge dropped by immutable defaults does not mark the header as explicit', _t => {
	const instance = got.extend({headers: {token: 'original'}});

	try {
		instance.defaults.options.merge({headers: {authorization: 'Bearer secret'}});
	} catch {}

	assert.strictEqual(instance.defaults.options.headers.authorization, undefined);
	assert.strictEqual(instance.defaults.options.isHeaderExplicitlySet('authorization'), false);
});

test('immutable defaults reject timeout merges without changing their budget', _t => {
	const {options} = got.extend({timeout: {request: 100}}).defaults;

	assert.throws(() => {
		options.merge({timeout: {request: 1, response: 2}});
	}, TypeError);
	assert.strictEqual(options.timeout.request, 100);
	assert.strictEqual(options.timeout.response, undefined);
});

test('immutable defaults reject merges before either init hook runs', _t => {
	let inheritedCalls = 0;
	let incomingCalls = 0;
	const {options} = got.extend({
		hooks: {
			init: [(_plain, options) => {
				inheritedCalls++;
				options.context.calls = inheritedCalls;
			}],
		},
	}).defaults;
	const initialCalls = inheritedCalls;

	assert.throws(() => {
		options.merge({
			hooks: {
				init: [() => {
					incomingCalls++;
				}],
			},
		});
	}, TypeError);
	assert.strictEqual(inheritedCalls, initialCalls);
	assert.strictEqual(incomingCalls, 0);
	assert.strictEqual(options.context.calls, initialCalls);
});

test('immutable defaults keep direct context mutations while rejecting context merges', _t => {
	const {options} = got.extend({context: {value: 'original'}}).defaults;
	options.context.value = 'direct';

	assert.throws(() => {
		options.merge({context: {value: 'merged'}});
	}, TypeError);
	assert.strictEqual(options.context.value, 'direct');
});

test('mutable defaults still merge nested options and explicit headers', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	const instance = got.extend({mutableDefaults: true, headers: {token: 'original'}});
	instance.defaults.options.merge({headers: {token: 'merged'}, timeout: {request: 5000}, context: {value: 'merged'}});

	assert.strictEqual((await instance('').json<Headers>()).token, 'merged');
	assert.strictEqual(instance.defaults.options.isHeaderExplicitlySet('token'), true);
	assert.strictEqual(instance.defaults.options.timeout.request, 5000);
	assert.strictEqual(instance.defaults.options.context.value, 'merged');
});

test('a mutable target can merge and then change frozen source options', _t => {
	const source = got.extend({headers: {token: 'source'}, timeout: {request: 100}}).defaults.options;
	const target = new Options({headers: {'x-local': 'kept'}});
	target.merge(source);
	target.headers.token = 'changed';
	target.timeout.request = 200;

	assert.strictEqual(target.headers['x-local'], 'kept');
	assert.strictEqual(target.headers.token, 'changed');
	assert.strictEqual(target.timeout.request, 200);
	assert.strictEqual(source.headers.token, 'source');
	assert.strictEqual(source.timeout.request, 100);
});

test('immutable defaults reject merging an Options instance but permit an absent merge', _t => {
	const {options} = got.extend().defaults;

	assert.throws(() => {
		options.merge(new Options({headers: {token: 'unexpected'}}));
	}, TypeError);
	assert.doesNotThrow(() => {
		options.merge();
	});
	assert.strictEqual(options.headers.token, undefined);
	assert.strictEqual(options.isHeaderExplicitlySet('token'), false);
});

test('a replacement stream handler releases its undispatched upload after completion', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('replacement');
	});
	let reads = 0;
	const body = new Readable({
		read() {
			reads++;
		},
	});
	const replacement = got.stream('');
	const client = got.extend({handlers: [(() => replacement) as HandlerFunction]});
	const result = client.stream.post('', {body});
	assert.strictEqual(result, replacement);
	assert.strictEqual(await getStream(result), 'replacement');
	await setImmediate();
	assert.strictEqual(reads, 0);
	assert.strictEqual(body.destroyed, true);
});

test('a replacement stream handler can consume the original request before releasing it', withServer, async (_t, server, got) => {
	let original: ReturnType<typeof got.stream> | undefined;
	server.get('/source', (_request, response) => {
		response.end('piped request body');
	});
	server.post('/target', async (request, response) => {
		const body = await getStream(request);
		assert.ok(original);
		assert.strictEqual(original.destroyed, false);
		response.end(body);
	});
	const client = got.extend({
		handlers: [((options, next) => {
			original = next(options) as ReturnType<typeof got.stream>;
			return original.pipe(got.stream.post('target'));
		}) as HandlerFunction],
	});
	assert.strictEqual(await getStream(client.stream('source')), 'piped request body');
	await setImmediate();
	assert.ok(original);
	assert.strictEqual(original.destroyed, true);
});

for (const withError of [false, true]) {
	test(`a replacement stream handler releases its unused body after destruction ${withError ? 'with' : 'without'} an error`, withServer, async (_t, _server, got) => {
		const replacement = got.stream('', {hooks: {beforeRequest: [async () => new Promise(() => {})]}});
		const body = new Readable({read() {}});
		const callerListener = () => {};
		body.on('error', callerListener);
		const client = got.extend({handlers: [(() => replacement) as HandlerFunction]});
		const result = client.stream.post('', {body});
		assert.strictEqual(result.listenerCount('error'), 0);
		const errors: Error[] = [];
		if (withError) {
			result.on('error', error => {
				errors.push(error);
			});
		}

		const closed = new Promise<void>(resolve => {
			result.once('close', resolve);
		});
		const cause = new Error('Replacement stream failed');
		result.destroy(withError ? cause : undefined);
		await closed;
		await setImmediate();
		assert.strictEqual(body.destroyed, true);
		assert.ok(body.listeners('error').includes(callerListener));
		assert.strictEqual(errors.length, withError ? 1 : 0);
		if (withError) {
			assert.strictEqual(errors[0]?.cause, cause);
		}

		assert.strictEqual(result.listenerCount('end'), 0);
		assert.strictEqual(result.listenerCount('finish'), 0);
	});
}

test('replacement stream ownership preserves native unhandled error reporting', async _t => {
	const script = `
		import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
		const replacement = got.stream('http://localhost/', {hooks: {beforeRequest: [() => new Promise(() => {})]}});
		const client = got.extend({handlers: [() => replacement]});
		const result = client.stream('http://localhost/');
		result.destroy(new Error('Unhandled replacement failure'));
	`;
	await assert.rejects(promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script]), error => {
		assert.strictEqual((error as {code?: number}).code, 1);
		assert.match((error as {stderr: string}).stderr, /Unhandled replacement failure/v);
		assert.match((error as {stderr: string}).stderr, /Unhandled 'error' event/v);
		return true;
	});
});
