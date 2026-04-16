import {Buffer} from 'node:buffer';
import {
	Agent as HttpAgent,
	request as httpRequest,
} from 'node:http';
import {PassThrough} from 'node:stream';
import test from 'ava';
import getStream from 'get-stream';
import sinon from 'sinon';
import delay from 'delay';
import type {Handler} from 'express';
import Responselike from 'responselike';
import type {Constructor} from 'type-fest';
import got, {
	RequestError,
	HTTPError,
	type Response,
	type OptionsInit,
	type RequestFunction,
} from '../source/index.js';
import {createCrossOriginReceiver, createRetryUrlServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';

const errorString = 'oops';
const error = new Error(errorString);

const echoHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

const echoBody: Handler = async (request, response) => {
	response.end(await getStream(request));
};

const echoUrl: Handler = (request, response) => {
	response.end(request.url);
};

const echoHeader = (header: 'authorization' | 'cookie'): Handler => (request, response) => {
	response.end(request.headers[header] ?? '');
};

const retryEndpoint: Handler = (request, response) => {
	if (request.headers.foo) {
		response.statusCode = 302;
		response.setHeader('location', '/');
		response.end();
	}

	response.statusCode = 500;
	response.end();
};

const redirectEndpoint: Handler = (_request, response) => {
	response.statusCode = 302;
	response.setHeader('location', '/');
	response.end();
};

const createStaticCookieJar = (cookie = 'session=from-jar') => ({
	async getCookieString() {
		return cookie;
	},
	async setCookie() {},
});

const echoAuthorization: Handler = (request, response) => {
	response.end(request.headers.authorization ?? '');
};

const addRetryHeaderEchoEndpoint = (server: {get: (path: string, handler: Handler) => void}, header: 'authorization' | 'cookie'): void => {
	let requestCount = 0;

	server.get('/api', (request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.statusCode = 401;
			response.end('retry');
			return;
		}

		response.end(request.headers[header] ?? '');
	});
};

const createAgentSpy = <T extends HttpAgent>(AgentClass: Constructor<any>): {agent: T; spy: sinon.SinonSpy} => {
	const agent: T = new AgentClass({keepAlive: true});
	const spy = sinon.spy(agent, 'addRequest' as any);
	return {agent, spy};
};

test('async hooks', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got<Record<string, string>>({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				async options => {
					await delay(100);
					options.headers.foo = 'bar';
				},
			],
		},
	});
	t.is(body.foo, 'bar');
});

test('catches init thrown errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('catches beforeRequest thrown errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			beforeRequest: [() => {
				throw error;
			}],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('catches beforeRedirect thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	await t.throwsAsync(got('redirect', {
		hooks: {
			beforeRedirect: [() => {
				throw error;
			}],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('catches beforeRetry thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	await t.throwsAsync(got('retry', {
		hooks: {
			beforeRetry: [() => {
				throw error;
			}],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('throws if afterResponse returns an invalid value', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got('', {
		hooks: {
			afterResponse: [
				// @ts-expect-error Testing purposes
				() => {},
			],
		},
	}), {
		message: 'The `afterResponse` hook returned an invalid value',
	});
});

test('catches afterResponse thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [() => {
				throw error;
			}],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('accepts an async function as init hook', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await got('', {
		hooks: {
			init: [

				async () => {
					t.pass();
				},
			],
		},
	});
});

test('catches beforeRequest promise rejections', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			beforeRequest: [
				async () => {
					throw error;
				},
			],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('catches beforeRedirect promise rejections', withServer, async (t, server, got) => {
	server.get('/', redirectEndpoint);

	await t.throwsAsync(got({
		hooks: {
			beforeRedirect: [
				async () => {
					throw error;
				},
			],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('catches beforeRetry promise rejections', withServer, async (t, server, got) => {
	server.get('/retry', retryEndpoint);

	await t.throwsAsync(got('retry', {
		hooks: {
			beforeRetry: [
				async () => {
					throw error;
				},
			],
		},
	}), {
		instanceOf: RequestError,
		message: errorString,
	});
});

test('catches afterResponse promise rejections', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [
				async () => {
					throw error;
				},
			],
		},
	}), {message: errorString});
});

test('catches beforeError errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		request() {
			throw new Error('No way');
		},
		hooks: {
			beforeError: [
				async () => {
					throw error;
				},
			],
		},
	}), {message: errorString});
});

test('init is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const context = {};

	await got({
		hooks: {
			init: [
				options => {
					t.deepEqual(options.context, context);
				},
			],
		},
		context,
	});
});

test('init from defaults is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const context = {};

	let count = 0;

	const instance = got.extend({
		hooks: {
			init: [
				options => {
					count += options.context ? 1 : 0;
				},
			],
		},
	});

	await instance({context});

	t.is(count, 1);
});

test('init allows modifications', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers.foo);
	});

	const options = {
		headers: {},
		hooks: {
			init: [
				(options: OptionsInit) => {
					options.headers = {
						foo: 'bar',
					};
				},
			],
		},
	};

	const {body} = await got('', options);

	t.deepEqual(options.headers, {});
	t.is(body, 'bar');
});

test('beforeRequest is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				options => {
					const url = options.url!;
					t.is(url.pathname, '/');
					t.is(url.hostname, 'localhost');
				},
			],
		},
	});
});

test('beforeRequest hook can observe generated authorization header', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.headers.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
				},
			],
		},
	});
});

test('beforeRequest hook can observe generated cookieJar header', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.headers.cookie, 'session=from-jar');
				},
			],
		},
	});
});

test('beforeRequest allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got<Record<string, string>>({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				options => {
					options.headers.foo = 'bar';
				},
			],
		},
	});
	t.is(body.foo, 'bar');
});

test('beforeRequest is called with context', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		hooks: {
			beforeRequest: [
				(_options, context) => {
					t.truthy(context);
					t.is(typeof context.retryCount, 'number');
				},
			],
		},
	});
});

test('beforeRequest context has retryCount 0 on initial request', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		hooks: {
			beforeRequest: [
				(_options, context) => {
					t.is(context.retryCount, 0);
				},
			],
		},
	});
});

test('beforeRequest context retryCount increments on retries', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	const retryCounts: number[] = [];

	await t.throwsAsync(got({
		retry: {
			limit: 2,
		},
		hooks: {
			beforeRequest: [
				(_options, context) => {
					retryCounts.push(context.retryCount);
				},
			],
		},
	}), {instanceOf: HTTPError});

	t.is(retryCounts.length, 3);
	t.is(retryCounts[0], 0); // Initial request
	t.is(retryCounts[1], 1); // First retry
	t.is(retryCounts[2], 2); // Second retry
});

test('returning HTTP response from a beforeRequest hook', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {statusCode, headers, body} = await got({
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {
						foo: 'bar',
					},
					body: Buffer.from('Hi!'),
					url: '',
				}),
			],
		},
	});

	t.is(statusCode, 200);
	t.is(headers.foo, 'bar');
	t.is(body, 'Hi!');
});

test('returning HTTP response from a beforeRequest hook with FormData body', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const form = new globalThis.FormData();
	form.set('field', 'value');

	const data = await got.post({
		body: form,
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('{"cached": "response"}'),
					url: '',
				}),
			],
		},
	}).json<{cached: string}>();

	t.is(data.cached, 'response');
});

test('returning HTTP response from a beforeRequest hook with large buffer body', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const {body} = await got.post({
		body: Buffer.alloc(1024 * 256, 'a'),
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('hooked'),
					url: '',
				}),
			],
		},
	});

	t.is(body, 'hooked');
});

test('returning HTTP response from a beforeRequest hook with large json body', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const data = await got.post({
		json: {
			key: '.'.repeat(1024 * 256),
		},
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('{"cached":"json"}'),
					url: '',
				}),
			],
		},
	}).json<{cached: string}>();

	t.is(data.cached, 'json');
});

test('returning HTTP response from a beforeRequest hook with large typed array body', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const {body} = await got.post({
		body: new Uint8Array(1024 * 256),
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('typed-array'),
					url: '',
				}),
			],
		},
	});

	t.is(body, 'typed-array');
});

test('returning HTTP response from a beforeRequest hook can observe generated cookieJar header', withServer, async (t, _server, got) => {
	const {body} = await got({
		cookieJar: {
			async getCookieString() {
				return 'session=from-jar';
			},
			async setCookie() {},
		},
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.headers.cookie, 'session=from-jar');

					return new Responselike({
						statusCode: 200,
						headers: {},
						body: Buffer.from('cached'),
						url: '',
					});
				},
			],
		},
	});

	t.is(body, 'cached');
});

test('returning HTTP response from a beforeRequest hook ignores conflicting transfer headers', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const {body} = await got.post({
		body: 'wow',
		headers: {
			'content-length': '1',
			'transfer-encoding': 'chunked',
		},
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('cached'),
					url: '',
				}),
			],
		},
	});

	t.is(body, 'cached');
});

test('beforeRedirect is called with options and response', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	await got('redirect', {
		responseType: 'json',
		hooks: {
			beforeRedirect: [
				(options, response) => {
					const url = options.url!;
					t.is(url.pathname, '/');
					t.is(url.hostname, 'localhost');

					t.is(response.statusCode, 302);
					t.is(new URL(response.url).pathname, '/redirect');
					t.is(response.redirectUrls.length, 1);
				},
			],
		},
	});
});

test('beforeRedirect allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	const {body} = await got<Record<string, string>>('redirect', {
		responseType: 'json',
		hooks: {
			beforeRedirect: [
				options => {
					options.headers.foo = 'bar';
				},
			],
		},
	});
	t.is(body.foo, 'bar');
});

test('returning HTTP response from a beforeRequest hook skips basic auth generation', withServer, async (t, server, got) => {
	server.get('/', echoAuthorization);

	const {body} = await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('cached'),
					url: '',
				}),
			],
		},
	});

	t.is(body, 'cached');
});

test('beforeRedirect hook can explicitly omit generated authorization', withServer, async (t, server, got) => {
	server.get('/redirect', redirectEndpoint);
	server.get('/', echoHeader('authorization'));

	const response = await got(`http://user:password@localhost:${server.port}/redirect`, {
		hooks: {
			beforeRedirect: [
				options => {
					options.headers.authorization = undefined;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('beforeRedirect hook can explicitly omit generated cookieJar cookies', withServer, async (t, server, got) => {
	server.get('/redirect', redirectEndpoint);
	server.get('/', echoHeader('cookie'));

	const response = await got(`http://localhost:${server.port}/redirect`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRedirect: [
				options => {
					options.headers.cookie = undefined;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('beforeRedirect hook clears stale generated cookie when cookieJar is removed', withServer, async (t, server, got) => {
	server.get('/redirect', redirectEndpoint);
	server.get('/', echoHeader('cookie'));

	const response = await got(`http://localhost:${server.port}/redirect`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRedirect: [
				options => {
					options.cookieJar = undefined;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('beforeRetry is called with options', withServer, async (t, server) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	const context = {};

	await got('retry', {
		prefixUrl: server.url,
		responseType: 'json',
		retry: {
			limit: 1,
		},
		throwHttpErrors: false,
		context,
		hooks: {
			beforeRetry: [
				(error, retryCount) => {
					const {options} = error;
					const {retryCount: requestRetryCount} = error.request!;
					t.is((options.url as URL).hostname, 'localhost');
					t.deepEqual(options.context, context);
					t.truthy(error);
					t.is(requestRetryCount, 0);
					t.is(retryCount, 1);
				},
			],
		},
	});
});

test('beforeRetry allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	const {body} = await got<Record<string, string>>('retry', {
		responseType: 'json',
		hooks: {
			beforeRetry: [
				({options}) => {
					options.headers.foo = 'bar';
				},
			],
		},
	});
	t.is(body.foo, 'bar');
});

test('beforeRetry allows stream body if different from original', withServer, async (t, server, got) => {
	server.post('/retry', async (request, response) => {
		if (request.headers.foo) {
			response.send('test');
		} else {
			response.statusCode = 500;
		}

		response.end();
	});

	const generateBody = () => {
		const form = new globalThis.FormData();
		form.set('A', 'B');
		return form;
	};

	const {body} = await got.post('retry', {
		body: generateBody(),
		retry: {
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					options.body = generateBody();
					options.headers.foo = 'bar';
				},
			],
		},
	});

	t.is(body, 'test');
});

test('prefixUrl is preserved in beforeRequest hook', withServer, async (t, server, got) => {
	server.get('/endpoint', (_request, response) => {
		response.end('success');
	});

	let capturedPrefixUrl: string | URL | undefined;

	await got('endpoint', {
		prefixUrl: server.url,
		hooks: {
			beforeRequest: [
				options => {
					capturedPrefixUrl = options.prefixUrl;
				},
			],
		},
	});

	const normalizedServerUrl = new URL(server.url).toString();
	t.is(capturedPrefixUrl, normalizedServerUrl);
});

test('prefixUrl is preserved in beforeRetry hook', withServer, async (t, server, got) => {
	server.get('/retry', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let capturedPrefixUrl: string | URL | undefined;

	await t.throwsAsync(got('retry', {
		prefixUrl: server.url,
		retry: {
			limit: 1,
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					capturedPrefixUrl = options.prefixUrl;
				},
			],
		},
	}));

	const normalizedServerUrl = new URL(server.url).toString();
	t.is(capturedPrefixUrl, normalizedServerUrl);
});

test('setting absolute URL in hook does not concatenate with prefixUrl', withServer, async (t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});

	server.get('/changed', (_request, response) => {
		response.end('changed');
	});

	const {body} = await got('original', {
		prefixUrl: server.url,
		hooks: {
			beforeRequest: [
				options => {
					// Set absolute URL - should not concatenate with prefixUrl
					options.url = new URL(`${server.url}/changed`);
				},
			],
		},
	});

	t.is(body, 'changed');
});

test('allows colon in path segment with prefixUrl (CouchDB user URLs)', withServer, async (t, server, serverGot) => {
	server.get('/_users/org.couchdb.user:test@user.com', (_request, response) => {
		response.end('user document');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/_users/`,
	});

	const {body} = await client.get('org.couchdb.user:test@user.com');
	t.is(body, 'user document');
});

test('allows multiple colons in path with prefixUrl', withServer, async (t, server, serverGot) => {
	server.get(/^\/api\/ns:type:id$/v, (_request, response) => {
		response.end('namespaced');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/api/`,
	});

	const {body} = await client.get('ns:type:id');
	t.is(body, 'namespaced');
});

test('allows mailto-like patterns in path with prefixUrl', withServer, async (t, server, serverGot) => {
	server.get('/users/mailto:test@example.com', (_request, response) => {
		response.end('email user');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/users/`,
	});

	const {body} = await client.get('mailto:test@example.com');
	t.is(body, 'email user');
});

test('allows URN-like patterns in path with prefixUrl', withServer, async (t, server, serverGot) => {
	server.get(/^\/resources\/urn:isbn:123$/v, (_request, response) => {
		response.end('book');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/resources/`,
	});

	const {body} = await client.get('urn:isbn:123');
	t.is(body, 'book');
});

test('afterResponse is called with response', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		responseType: 'json',
		hooks: {
			afterResponse: [
				response => {
					t.is(typeof response.body, 'object');

					return response;
				},
			],
		},
	});
});

test('afterResponse allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got<Record<string, string>>({
		responseType: 'json',
		hooks: {
			afterResponse: [
				response => {
					response.body = {hello: 'world'};
					return response;
				},
			],
		},
	});
	t.is(body.hello, 'world');
});

test('afterResponse allows to retry', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
		},
	});
	t.is(statusCode, 200);
});

test('afterResponse allows to retry without losing the port', withServer, async (t, server) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	const {statusCode} = await got(server.url, {
		hooks: {
			afterResponse: [
				(response: Response, retryWithMergedOptions: (options: OptionsInit) => never) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
		},
	});
	t.is(statusCode, 200);
});

test('cancelling the request after retrying in a afterResponse hook', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end();
	});

	const controller = new AbortController();

	const gotPromise = got({
		signal: controller.signal,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => {
					const promise = retryWithMergedOptions({
						headers: {
							token: 'unicorn',
						},
					});

					controller.abort();

					return promise;
				},
			],
		},
		retry: {
			calculateDelay: () => 1,
		},
	});

	await t.throwsAsync(gotPromise);
	await delay(100);
	t.is(requests, 1);
});

test('afterResponse allows to retry - `beforeRetry` hook', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	let isCalled = false;

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
			beforeRetry: [
				options => {
					t.truthy(options);
					isCalled = true;
				},
			],
		},
	});
	t.is(statusCode, 200);
	t.true(isCalled);
});

test('no infinity loop when retrying on afterResponse', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	await t.throwsAsync(got({
		retry: {
			limit: 0,
		},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					headers: {
						token: 'invalid',
					},
				}),
			],
		},
	}), {instanceOf: HTTPError, message: /^Request failed with status code 401 \(Unauthorized\): GET http:\/\/localhost:\d+\/$/v});
});

test('throws on afterResponse retry failure', withServer, async (t, server, got) => {
	let didVisit401then500: boolean;
	server.get('/', (_request, response) => {
		if (didVisit401then500) {
			response.statusCode = 500;
		} else {
			didVisit401then500 = true;
			response.statusCode = 401;
		}

		response.end();
	});

	await t.throwsAsync(got({
		retry: {
			limit: 1,
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
		},
	}), {instanceOf: HTTPError, message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/v});
});

test('does not throw on afterResponse retry HTTP failure if throwHttpErrors is false', withServer, async (t, server, got) => {
	let didVisit401then500: boolean;
	server.get('/', (_request, response) => {
		if (didVisit401then500) {
			response.statusCode = 500;
		} else {
			didVisit401then500 = true;
			response.statusCode = 401;
		}

		response.end();
	});

	const {statusCode} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
		},
	});
	t.is(statusCode, 500);
});

test('afterResponse preserveHooks keeps remaining hooks on retry', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	let firstHookCalls = 0;
	let secondHookCalls = 0;

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					firstHookCalls++;

					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
							preserveHooks: true,
						});
					}

					return response;
				},
				response => {
					secondHookCalls++;
					return response;
				},
			],
		},
	});

	t.is(statusCode, 200);
	t.is(firstHookCalls, 2); // Called for both original and retry
	t.is(secondHookCalls, 1); // Called only on retry (original was interrupted by RetryError)
});

test('afterResponse without preserveHooks skips remaining hooks on retry', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	let firstHookCalls = 0;
	let secondHookCalls = 0;

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					firstHookCalls++;

					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
				response => {
					secondHookCalls++;
					return response;
				},
			],
		},
	});

	t.is(statusCode, 200);
	t.is(firstHookCalls, 1); // Called only on original request (removed from retry by default)
	t.is(secondHookCalls, 0); // Never called (removed by slice before it could run)
});

test('afterResponse preserveHooks with three hooks', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	let firstHookCalls = 0;
	let secondHookCalls = 0;
	let thirdHookCalls = 0;

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					firstHookCalls++;

					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
							preserveHooks: true,
						});
					}

					return response;
				},
				response => {
					secondHookCalls++;
					return response;
				},
				response => {
					thirdHookCalls++;
					return response;
				},
			],
		},
	});

	t.is(statusCode, 200);
	t.is(firstHookCalls, 2); // Called for both original and retry
	t.is(secondHookCalls, 1); // Called only on retry
	t.is(thirdHookCalls, 1); // Called only on retry
});

test('afterResponse preserveHooks when second hook triggers retry', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	let firstHookCalls = 0;
	let secondHookCalls = 0;
	let thirdHookCalls = 0;

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				response => {
					firstHookCalls++;
					return response;
				},
				(response, retryWithMergedOptions) => {
					secondHookCalls++;

					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn',
							},
							preserveHooks: true,
						});
					}

					return response;
				},
				response => {
					thirdHookCalls++;
					return response;
				},
			],
		},
	});

	t.is(statusCode, 200);
	t.is(firstHookCalls, 2); // Called for both original and retry (preserved by preserveHooks)
	t.is(secondHookCalls, 2); // Called for both original and retry
	t.is(thirdHookCalls, 1); // Called only on retry
});

test('throwing in a beforeError hook - promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [
				() => {
					throw error;
				},
			],
			beforeError: [
				(): never => {
					throw new Error('foobar');
				},
				() => {
					throw new Error('This shouldn\'t be called at all');
				},
			],
		},
	}), {message: 'foobar'});
});

test('throwing in a beforeError hook - stream', withServer, async (t, _server, got) => {
	await t.throwsAsync(getStream(got.stream({
		hooks: {
			beforeError: [
				() => {
					throw new Error('foobar');
				},
				() => {
					throw new Error('This shouldn\'t be called at all');
				},
			],
		},
	})), {message: 'foobar'});
});

test('beforeError is called with an error - promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let capturedError2: unknown;

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [
				() => {
					throw error;
				},
			],
			beforeError: [error2 => {
				capturedError2 = error2;
				return error2;
			}],
		},
	}), {message: errorString});

	t.true(capturedError2 instanceof Error);
});

test('beforeError is called with an error - stream', withServer, async (t, _server, got) => {
	let capturedError2: unknown;

	await t.throwsAsync(getStream(got.stream({
		hooks: {
			beforeError: [error2 => {
				capturedError2 = error2;
				return error2;
			}],
		},
	})), {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v});

	t.true(capturedError2 instanceof Error);
});

test('beforeError allows modifications', async t => {
	const errorString2 = 'foobar';

	await t.throwsAsync(got('https://example.com', {
		request() {
			throw error;
		},
		hooks: {
			beforeError: [
				error => {
					const newError = new Error(errorString2);

					return new RequestError(newError.message, newError, error.options);
				},
			],
		},
	}), {message: errorString2});
});

test('does not break on `afterResponse` hook with JSON mode', withServer, async (t, server, got) => {
	server.get('/foobar', echoHeaders);

	await t.notThrowsAsync(got('', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 404) {
						return retryWithMergedOptions({
							url: new URL('/foobar', response.url),
						});
					}

					return response;
				},
			],
		},
		responseType: 'json',
	}));
});

test('catches HTTPErrors', withServer, async (t, _server, got) => {
	let capturedError: unknown;

	await t.throwsAsync(got({
		hooks: {
			beforeError: [
				error => {
					capturedError = error;
					return error;
				},
			],
		},
	}));

	t.true(capturedError instanceof HTTPError);
});

test('timeout can be modified using a hook', withServer, async (t, server, got) => {
	server.get('/', () => {});

	await t.throwsAsync(got({
		timeout: {
			request: 1000,
		},
		hooks: {
			beforeRequest: [
				options => {
					options.timeout.request = 500;
				},
			],
		},
		retry: {
			limit: 1,
		},
	}), {message: 'Timeout awaiting \'request\' for 500ms'});
});

test('beforeRequest hook is called before each request', withServer, async (t, server, got) => {
	server.post('/', echoUrl);
	server.post('/redirect', redirectEndpoint);

	const buffer = Buffer.from('Hello, Got!');
	let counts = 0;

	await got.post('redirect', {
		body: buffer,
		hooks: {
			beforeRequest: [
				options => {
					counts++;
					t.is(options.headers['content-length'], String(buffer.length));
				},
			],
		},
	});

	t.is(counts, 2);
});

test('beforeError emits valid promise `HTTPError`s', withServer, async (t, server, got) => {
	t.plan(3);

	server.get('/', (_request, response) => {
		response.writeHead(422);
		response.end('no');
	});

	const instance = got.extend({
		hooks: {
			beforeError: [
				error => {
					t.true(error instanceof HTTPError);
					t.truthy(error.response!.body);

					return error;
				},
			],
		},
		retry: {
			limit: 0,
		},
	});

	await t.throwsAsync(instance(''));
});

test('hooks are not duplicated', withServer, async (t, _server, got) => {
	let calls = 0;

	await t.throwsAsync(got({
		hooks: {
			beforeError: [
				error => {
					calls++;

					return error;
				},
			],
		},
		retry: {
			limit: 0,
		},
	}), {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v});

	t.is(calls, 1);
});

test('async afterResponse allows to retry with allowGetBody and json payload', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	const {statusCode} = await got({
		allowGetBody: true,
		json: {hello: 'world'},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({headers: {token: 'unicorn'}});
					}

					return response;
				},
			],
		},
		retry: {
			limit: 0,
		},
		throwHttpErrors: false,
	});

	t.is(statusCode, 200);
});

test('beforeRequest hook respect `agent` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent} = createAgentSpy(HttpAgent);

	t.truthy((await got({
		hooks: {
			beforeRequest: [
				options => {
					options.agent = {
						http: agent,
					};
				},
			],
		},
	})).body);

	// Make sure to close all open sockets
	agent.destroy();
});

test('beforeRequest hook respect `url` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ko');
	});

	server.get('/changed', (_request, response) => {
		response.end('ok');
	});

	t.is((await got(server.hostname, {
		hooks: {
			beforeRequest: [
				options => {
					options.url = new URL(`${server.url}/changed`);
				},
			],
		},
	})).body, 'ok');
});

test('beforeRequest hook refreshes cookieJar cookies when changing URL', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		server2.get('/changed', (request, response) => {
			response.end(JSON.stringify({
				cookie: request.headers.cookie,
			}));
		});

		const cookieJar = {
			async getCookieString(url: string) {
				return url.startsWith(server2.url) ? 'target=server2' : 'target=server1';
			},
			async setCookie() {},
		};

		const {cookie} = await got(`http://localhost:${server1.port}/original`, {
			cookieJar,
			hooks: {
				beforeRequest: [
					options => {
						options.url = new URL(`${server2.url}/changed`);
					},
				],
			},
		}).json<{cookie?: string}>();

		t.is(cookie, 'target=server2');
	});
});

test('beforeRequest hook refreshes basic auth when changing URL credentials', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		server2.get('/changed', (request, response) => {
			response.end(JSON.stringify({
				authorization: request.headers.authorization,
			}));
		});

		const {authorization} = await got(`http://old-user:old-password@localhost:${server1.port}/original`, {
			hooks: {
				beforeRequest: [
					options => {
						options.url = new URL(`http://new-user:new-password@localhost:${server2.port}/changed`);
					},
				],
			},
		}).json<{authorization?: string}>();

		t.is(authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	});
});

test('beforeRequest hook omits authorization after deleting explicit authorization and changing URL credentials', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		server2.get('/changed', (request, response) => {
			response.end(JSON.stringify({
				authorization: request.headers.authorization,
			}));
		});

		const {authorization} = await got(`http://old-user:old-password@localhost:${server1.port}/original`, {
			headers: {
				authorization: 'Bearer replacement-token',
			},
			hooks: {
				beforeRequest: [
					options => {
						delete options.headers.authorization;
						options.url = new URL(`http://new-user:new-password@localhost:${server2.port}/changed`);
					},
				],
			},
		}).json<{authorization?: string}>();

		t.is(authorization, undefined);
	});
});

test('beforeRequest hook drops conflicting content-length when transfer-encoding is added', withServer, async (t, server, got) => {
	server.post('/', echoHeaders);

	const {body} = await got.post(server.url, {
		body: 'wow',
		hooks: {
			beforeRequest: [
				options => {
					options.headers = {
						...options.headers,
						'content-length': '1',
						'transfer-encoding': 'chunked',
					};
				},
			],
		},
	});

	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked');
	t.is(headers['content-length'], undefined);
});

test('beforeRequest hook clears generated basic auth when credentials are removed', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				options => {
					options.username = '';
					options.password = '';
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, undefined);
});

test('beforeRequest hook preserves explicit authorization header when clearing URL credentials', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		headers: {
			authorization: 'Bearer replacement-token',
		},
		hooks: {
			beforeRequest: [
				options => {
					options.username = '';
					options.password = '';
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, 'Bearer replacement-token');
});

test('beforeRequest hook preserves same-value authorization header when clearing URL credentials', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const authorizationHeader = `Basic ${Buffer.from('user:password').toString('base64')}`;
	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				options => {
					options.headers.authorization = authorizationHeader;
					options.username = '';
					options.password = '';
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, authorizationHeader);
});

test('beforeRequest hook preserves explicit authorization override when URL credentials remain', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				options => {
					options.headers.authorization = 'Bearer replacement-token';
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, 'Bearer replacement-token');
});

test('beforeRequest hook can delete an explicit authorization header without restoring it', withServer, async (t, server, got) => {
	server.get('/', echoHeader('authorization'));

	const response = await got(`http://user:password@localhost:${server.port}/`, {
		headers: {
			authorization: 'Bearer replacement-token',
		},
		hooks: {
			beforeRequest: [
				options => {
					delete options.headers.authorization;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('beforeRequest hook omits authorization for custom requests after deleting explicit override and changing credentials', withServer, async (t, server, got) => {
	server.get('/', echoHeader('authorization'));

	const request: RequestFunction = (url, options, callback) => {
		t.is((options.headers as Record<string, string | undefined> | undefined)?.authorization, undefined);
		return httpRequest(url, options, callback);
	};

	const response = await got(`http://old-user:old-password@localhost:${server.port}/`, {
		request,
		headers: {
			authorization: 'Bearer replacement-token',
		},
		hooks: {
			beforeRequest: [
				options => {
					delete options.headers.authorization;
					options.username = 'new-user';
					options.password = 'new-password';
				},
			],
		},
	});

	t.is(response.body, '');
});

test('beforeRequest hook regenerates authorization header for custom requests after changing credentials', withServer, async (t, server, got) => {
	server.get('/', echoHeader('authorization'));

	const request: RequestFunction = (url, options, callback) => {
		t.is((options.headers as Record<string, string | undefined> | undefined)?.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
		return httpRequest(url, options, callback);
	};

	const response = await got(`http://old-user:old-password@localhost:${server.port}/`, {
		request,
		hooks: {
			beforeRequest: [
				options => {
					options.username = 'new-user';
					options.password = 'new-password';
				},
			],
		},
	});

	t.is(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('beforeRequest hook can explicitly omit generated authorization', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				options => {
					options.headers.authorization = undefined;
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, undefined);
});

test('beforeRequest hook can replace initially omitted authorization', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		headers: {
			authorization: undefined,
		},
		hooks: {
			beforeRequest: [
				options => {
					options.headers.authorization = 'Bearer replacement-token';
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, 'Bearer replacement-token');
});

test('beforeRequest hook can explicitly omit generated cookieJar cookies', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					options.headers.cookie = undefined;
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, undefined);
});

test('beforeRequest hook can replace initially omitted cookie header', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		headers: {
			cookie: undefined,
		},
		hooks: {
			beforeRequest: [
				options => {
					options.headers.cookie = 'session=replaced';
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, 'session=replaced');
});

test('beforeRequest hook can omit generated authorization for a single retry attempt', withServer, async (t, server, got) => {
	let requestCount = 0;
	server.get('/', (request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.statusCode = 500;
			response.end();
			return;
		}

		response.end(JSON.stringify({
			authorization: request.headers.authorization,
		}));
	});

	const {authorization} = await got(`http://user:password@localhost:${server.port}/`, {
		retry: {
			limit: 1,
			statusCodes: [500],
		},
		hooks: {
			beforeRequest: [
				(options, context) => {
					if (context.retryCount === 0) {
						options.headers.authorization = undefined;
					}
				},
			],
		},
	}).json<{authorization?: string}>();

	t.is(authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
});

test('beforeRequest hook can omit generated cookieJar cookies for a single retry attempt', withServer, async (t, server, got) => {
	let requestCount = 0;
	server.get('/', (request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.statusCode = 500;
			response.end();
			return;
		}

		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		retry: {
			limit: 1,
			statusCodes: [500],
		},
		hooks: {
			beforeRequest: [
				(options, context) => {
					if (context.retryCount === 0) {
						options.headers.cookie = undefined;
					}
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, 'session=from-jar');
});

test('beforeRequest hook preserves same-value cookie header when removing cookieJar', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					options.headers.cookie = 'session=from-jar';
					options.cookieJar = undefined;
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, 'session=from-jar');
});

test('beforeRequest hook preserves explicit cookie override when cookieJar remains', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					options.headers.cookie = 'session=override';
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, 'session=override');
});

test('beforeRequest hook preserves initial explicit cookie when disabling cookieJar', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		headers: {
			cookie: 'session=from-jar',
		},
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					options.cookieJar = undefined;
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, 'session=from-jar');
});

test('beforeRequest hook clears stale generated cookie when cookieJar is removed', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			cookie: request.headers.cookie,
		}));
	});

	const {cookie} = await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					options.cookieJar = undefined;
				},
			],
		},
	}).json<{cookie?: string}>();

	t.is(cookie, undefined);
});

test('beforeRequest hook clears stale cookieJar cookie when changing URL to a cookie-less destination', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		server2.get('/changed', (request, response) => {
			response.end(JSON.stringify({
				cookie: request.headers.cookie,
			}));
		});

		const cookieJar = {
			async getCookieString(url: string) {
				return url.startsWith(server1.url) ? 'target=server1' : '';
			},
			async setCookie() {},
		};

		const {cookie} = await got(`http://localhost:${server1.port}/original`, {
			cookieJar,
			hooks: {
				beforeRequest: [
					options => {
						options.url = new URL(`${server2.url}/changed`);
					},
				],
			},
		}).json<{cookie?: string}>();

		t.is(cookie, undefined);
	});
});

test('no duplicate hook calls in single-page paginated requests', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('i <3 koalas');
	});

	let beforeHookCount = 0;
	let beforeHookCountAdditional = 0;
	let afterHookCount = 0;
	let afterHookCountAdditional = 0;

	const hooks = {
		beforeRequest: [
			() => {
				beforeHookCount++;
			},
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			},
		],
	};

	// Test only one request
	const instance = got.extend({
		hooks,
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: response => [response],
		},
	});

	await instance.paginate.all('get');
	t.is(beforeHookCount, 1);
	t.is(afterHookCount, 1);

	await instance.paginate.all('get', {
		hooks: {
			beforeRequest: [
				() => {
					beforeHookCountAdditional++;
				},
			],
			afterResponse: [
				(response: any) => {
					afterHookCountAdditional++;
					return response;
				},
			],
		},
	});
	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	t.is(beforeHookCountAdditional, 1);
	t.is(afterHookCountAdditional, 1);

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate: () => false,
			transform: response => [response],
		},
	});

	t.is(beforeHookCount, 3);
	t.is(afterHookCount, 3);
});

test('no duplicate hook calls in sequential paginated requests', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('i <3 unicorns');
	});

	let requestNumber = 0;
	let beforeHookCount = 0;
	let afterHookCount = 0;

	const hooks = {
		beforeRequest: [
			() => {
				beforeHookCount++;
			},
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			},
		],
	};

	// Test only two requests, one after another
	const paginate = () => requestNumber++ === 0 ? {} : false;

	const instance = got.extend({
		hooks,
		pagination: {
			paginate,
			countLimit: 2009,
			transform: response => [response],
		},
	});

	await instance.paginate.all('get');

	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	requestNumber = 0;

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			transform: response => [response],
		},
	});

	t.is(beforeHookCount, 4);
	t.is(afterHookCount, 4);
});

test('intentional duplicate hooks in pagination with extended instance', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('<3');
	});

	let beforeCount = 0; // Number of times the hooks from `extend` are called
	let afterCount = 0;
	let beforeCountAdditional = 0; // Number of times the added hooks are called
	let afterCountAdditional = 0;

	const beforeHook = () => {
		beforeCount++;
	};

	const afterHook = (response: any) => {
		afterCount++;
		return response;
	};

	const instance = got.extend({
		hooks: {
			beforeRequest: [
				beforeHook,
				beforeHook,
			],
			afterResponse: [
				afterHook,
				afterHook,
			],
		},
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: response => [response],
		},
	});

	// Add duplicate hooks when calling paginate
	const beforeHookAdditional = () => {
		beforeCountAdditional++;
	};

	const afterHookAdditional = (response: any) => {
		afterCountAdditional++;
		return response;
	};

	await instance.paginate.all('get', {
		hooks: {
			beforeRequest: [
				beforeHook,
				beforeHookAdditional,
				beforeHookAdditional,
			],
			afterResponse: [
				afterHook,
				afterHookAdditional,
				afterHookAdditional,
			],
		},
	});

	t.is(beforeCount, 3);
	t.is(afterCount, 3);
	t.is(beforeCountAdditional, 2);
	t.is(afterCountAdditional, 2);
});

test('no duplicate hook calls when returning original request options', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('i <3 unicorns');
	});

	let requestNumber = 0;
	let beforeHookCount = 0;
	let afterHookCount = 0;

	const hooks = {
		beforeRequest: [
			() => {
				beforeHookCount++;
			},
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			},
		],
	};

	// Test only two requests, one after another
	const paginate = ({response}: {response: Response}) => requestNumber++ === 0 ? response.request.options : false;

	const instance = got.extend({
		hooks,
		pagination: {
			paginate,
			countLimit: 2009,
			transform: response => [response],
		},
	});

	await instance.paginate.all('get');

	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	requestNumber = 0;

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			transform: response => [response],
		},
	});

	t.is(beforeHookCount, 4);
	t.is(afterHookCount, 4);
});

test('`beforeRequest` change body', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const response = await got.post({
		json: {payload: 'old'},
		hooks: {
			beforeRequest: [
				options => {
					options.body = JSON.stringify({payload: 'new'});
					options.headers['content-length'] = Buffer.byteLength(options.body as string).toString();
				},
			],
		},
	});

	t.is(JSON.parse(response.body).payload, 'new');
});

test('`beforeRequest` change body with multi-byte characters', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const response = await got.post({
		json: {payload: 'old'},
		hooks: {
			beforeRequest: [
				options => {
					// Use multi-byte UTF-8 characters (emoji, accented characters)
					options.body = JSON.stringify({payload: 'new 🦄 café'});
					options.headers['content-length'] = Buffer.byteLength(options.body as string).toString();
				},
			],
		},
	});

	t.is(JSON.parse(response.body).payload, 'new 🦄 café');
});

test('can retry without an agent', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 408;
		response.end();
	});

	let counter = 0;

	class MyAgent extends HttpAgent {
		override createConnection(...args: Parameters<InstanceType<typeof HttpAgent>['createConnection']>): ReturnType<InstanceType<typeof HttpAgent>['createConnection']> {
			counter++;

			return (HttpAgent as any).prototype.createConnection.apply(this, args as any);
		}
	}

	const {response} = (await t.throwsAsync<HTTPError>(got({
		agent: {
			http: new MyAgent(),
		},
		hooks: {
			beforeRetry: [
				error => {
					error.options.agent.http = undefined;
				},
			],
		},
		retry: {
			calculateDelay: ({computedValue}) => computedValue ? 1 : 0,
		},
	})));

	t.is(response.retryCount, 2);
	t.is(counter, 1);
});

test('does not throw on empty body when running afterResponse hooks', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	await t.notThrowsAsync(got('', {
		hooks: {
			afterResponse: [
				response => response,
			],
		},
	}));
});

test('does not throw on null body with afterResponse hook and responseType json', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end('null');
	});

	const instance = got.extend({
		hooks: {
			afterResponse: [response => response],
		},
	});

	const {body} = await instance.get('', {responseType: 'json'});
	t.is(body, null);
});

test('does not throw on null body with afterResponse hook and responseType json - resolveBodyOnly', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end('null');
	});

	const instance = got.extend({
		hooks: {
			afterResponse: [response => response],
		},
	});

	const body = await instance.get('', {
		responseType: 'json',
		resolveBodyOnly: true,
	});
	t.is(body, null);
});

test('does not call beforeError hooks on falsy throwHttpErrors', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	let called = false;

	await got('', {
		throwHttpErrors: false,
		hooks: {
			beforeError: [
				error => {
					called = true;
					return error;
				},
			],
		},
	});

	t.false(called);
});

test('beforeError hook is called for ERR_UNSUPPORTED_PROTOCOL', async t => {
	let hookCalled = false;

	const beforeErrorHook = (error: RequestError) => {
		hookCalled = true;
		return error;
	};

	await t.throwsAsync(
		got.post('xhttps://example.com', {
			headers: {authorization: 'Bearer secret'},
			json: {foo: 42},
			hooks: {
				beforeError: [beforeErrorHook],
			},
		}),
		{code: 'ERR_UNSUPPORTED_PROTOCOL'},
	);

	t.true(hookCalled);
});

test('beforeError hook can redact sensitive headers for ERR_UNSUPPORTED_PROTOCOL', async t => {
	const redactAuthorizationHeader = (error: RequestError) => {
		if (error.options?.headers?.authorization) {
			error.options.headers.authorization = '<redacted>';
		}

		return error;
	};

	const error = await t.throwsAsync<RequestError>(
		got.post('xhttps://example.com/some/resource', {
			headers: {authorization: 'Bearer secret'},
			json: {foo: 42},
			hooks: {
				beforeError: [redactAuthorizationHeader],
			},
		}),
		{code: 'ERR_UNSUPPORTED_PROTOCOL'},
	);

	t.is(error?.options.headers.authorization, '<redacted>');
});

test('beforeRetry can reassign plain stream body', withServer, async (t, server, got) => {
	const {Readable: readable} = await import('node:stream');
	let requestCount = 0;
	const testData = 'Hello, Got!';

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		// First request fails, second succeeds
		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Server Error');
		} else {
			response.statusCode = 200;
			response.end(`Received: ${body}`);
		}
	});

	// Factory function to create fresh streams
	const createStream = () => readable.from([testData]);

	const response = await got.post('retry', {
		body: createStream(),
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					// Reassign with a fresh stream - this previously failed
					options.body = createStream();
				},
			],
		},
	});

	t.is(response.statusCode, 200);
	t.is(response.body, `Received: ${testData}`);
	t.is(requestCount, 2);
});

test('beforeRetry destroys old stream when reassigning body', withServer, async (t, server, got) => {
	const {Readable: readable} = await import('node:stream');
	let requestCount = 0;
	const testData = 'Stream data';

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		// First request fails, second succeeds
		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Server Error');
		} else {
			response.statusCode = 200;
			response.end(`Received: ${body}`);
		}
	});

	const createStream = () => readable.from([testData]);
	const firstStream = createStream();
	let oldStreamDestroyed = false;

	// Monitor when the old stream is destroyed
	firstStream.on('close', () => {
		oldStreamDestroyed = true;
	});

	await got.post('retry', {
		body: firstStream,
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					// Reassign with a fresh stream
					options.body = createStream();
				},
			],
		},
	});

	t.true(oldStreamDestroyed, 'Old stream should be destroyed to prevent memory leak');
	t.is(requestCount, 2);
});

test('beforeRetry handles multiple retries with stream reassignment', withServer, async (t, server, got) => {
	const {Readable: readable} = await import('node:stream');
	let requestCount = 0;
	const testData = 'Multi-retry data';

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		// First two requests fail, third succeeds
		if (requestCount < 3) {
			response.statusCode = 500;
			response.end('Server Error');
		} else {
			response.statusCode = 200;
			response.end(`Received: ${body}`);
		}
	});

	const createStream = () => readable.from([testData]);
	const destroyedStreams: number[] = [];
	let streamId = 0;

	const response = await got.post('retry', {
		body: createStream(),
		retry: {
			limit: 2,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					const currentStreamId = ++streamId;
					const newStream = createStream();
					newStream.on('close', () => {
						destroyedStreams.push(currentStreamId);
					});
					options.body = newStream;
				},
			],
		},
	});

	t.is(response.statusCode, 200);
	t.is(response.body, `Received: ${testData}`);
	t.is(requestCount, 3);
	t.is(destroyedStreams.length, 2, 'All old streams should be destroyed');
});

test('beforeRetry routes invalid reassigned stream body through normal error handling', withServer, async (t, server, got) => {
	let requestCount = 0;

	server.post('/retry', async (request, response) => {
		requestCount++;
		for await (const chunk of request) {
			void chunk;
		}

		response.statusCode = 500;
		response.end('Server Error');
	});

	const error = await t.throwsAsync(got.post('retry', {
		body: 'payload',
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					const replacementStream = new PassThrough();
					options.body = replacementStream;
					replacementStream.destroy();
				},
			],
		},
	}), {
		message: 'The reassigned stream body must be readable. Ensure you provide a fresh, readable stream in the beforeRetry hook.',
	});

	t.truthy(error);
	t.is(requestCount, 1);
});

test('beforeRetry accepts ended pass-through stream reassignment', withServer, async (t, server, got) => {
	let requestCount = 0;

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Server Error');
			return;
		}

		response.end(body);
	});

	const response = await got.post('retry', {
		body: 'payload',
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					const replacementStream = new PassThrough();
					replacementStream.end('payload');
					options.body = replacementStream;
				},
			],
		},
	});

	t.is(response.body, 'payload');
	t.is(requestCount, 2);
});

test('beforeRetry handles non-stream body reassignment', withServer, async (t, server, got) => {
	let requestCount = 0;

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Server Error');
		} else {
			response.statusCode = 200;
			response.end(`Received: ${body}`);
		}
	});

	const response = await got.post('retry', {
		body: 'initial body',
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					// Reassign with a different string body
					options.body = 'retried body';
				},
			],
		},
	});

	t.is(response.statusCode, 200);
	t.is(response.body, 'Received: retried body');
	t.is(requestCount, 2);
});

test('beforeRetry handles body set to undefined', withServer, async (t, server, got) => {
	const {Readable: readable} = await import('node:stream');
	let requestCount = 0;

	server.post('/retry', async (_request, response) => {
		requestCount++;
		// First request fails, second succeeds (with no body)
		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Error');
		} else {
			response.statusCode = 200;
			response.end('Success');
		}
	});

	await got.post('retry', {
		body: readable.from(['initial']),
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					options.body = undefined;
				},
			],
		},
	});

	t.is(requestCount, 2);
});

test('beforeRetry handles body from undefined to stream', withServer, async (t, server, got) => {
	const {Readable: readable} = await import('node:stream');
	let requestCount = 0;

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Error');
		} else {
			response.statusCode = 200;
			response.end(`Got: ${body}`);
		}
	});

	const response = await got.post('retry', {
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					options.body = readable.from(['stream-data']);
				},
			],
		},
	});

	t.is(response.body, 'Got: stream-data');
	t.is(requestCount, 2);
});

test('beforeRetry handles stream to Buffer conversion', withServer, async (t, server, got) => {
	const {Readable: readable} = await import('node:stream');
	let requestCount = 0;

	server.post('/retry', async (request, response) => {
		requestCount++;
		let body = '';
		for await (const chunk of request) {
			body += String(chunk);
		}

		if (requestCount === 1) {
			response.statusCode = 500;
			response.end('Error');
		} else {
			response.statusCode = 200;
			response.end(`Got: ${body}`);
		}
	});

	const response = await got.post('retry', {
		body: readable.from(['initial']),
		retry: {
			limit: 1,
			methods: ['POST'],
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					options.body = Buffer.from('buffer-data');
				},
			],
		},
	});

	t.is(response.body, 'Got: buffer-data');
	t.is(requestCount, 2);
});

test('handler error is properly thrown in .json()', withServer, async (t, _server, got) => {
	const customError = new Error('Custom handler error');
	const instance = got.extend({
		handlers: [
			(options, next) => (async () => {
				try {
					return await next(options);
				} catch {
					throw customError;
				}
			})(),
		],
	});

	await t.throwsAsync(instance('').json(), {message: 'Custom handler error'});
});

test('handler error is properly thrown in .text()', withServer, async (t, _server, got) => {
	const customError = new Error('Custom handler error for text');
	const instance = got.extend({
		handlers: [
			(options, next) => (async () => {
				try {
					return await next(options);
				} catch {
					throw customError;
				}
			})(),
		],
	});

	await t.throwsAsync(instance('').text(), {message: 'Custom handler error for text'});
});

test('handler error is properly thrown in .buffer()', withServer, async (t, _server, got) => {
	const customError = new Error('Custom handler error for buffer');
	const instance = got.extend({
		handlers: [
			(options, next) => (async () => {
				try {
					return await next(options);
				} catch {
					throw customError;
				}
			})(),
		],
	});

	await t.throwsAsync(instance('').buffer(), {message: 'Custom handler error for buffer'});
});

test('handler throwing on successful response works with .json()', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end('{"success": true}');
	});

	const customError = new Error('Handler rejected success');
	const instance = got.extend({
		handlers: [
			(options, next) => (async () => {
				await next(options);
				throw customError;
			})(),
		],
	});

	await t.throwsAsync(instance('').json(), {message: 'Handler rejected success'});
});

test('multiple handlers with error transformation work with .json()', withServer, async (t, _server, got) => {
	const instance = got.extend({
		handlers: [
			// First handler: catches and wraps error
			(options, next) => (async () => {
				try {
					return await next(options);
				} catch (error: any) {
					const wrappedError = new Error(`Handler 1: ${error.message}`);
					throw wrappedError;
				}
			})(),
			// Second handler: catches and wraps error again
			(options, next) => (async () => {
				try {
					return await next(options);
				} catch (error: any) {
					const wrappedError = new Error(`Handler 2: ${error.message}`);
					throw wrappedError;
				}
			})(),
		],
	});

	// Should get error from first handler (outermost)
	await t.throwsAsync(instance('').json(), {message: /Handler 1: Handler 2:/v});
});

test('beforeError can return custom Error class', async t => {
	class CustomError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'CustomError';
		}
	}

	const customMessage = 'This is a custom error';

	const error = await t.throwsAsync(got('https://example.com', {
		request() {
			throw new Error('Original error');
		},
		hooks: {
			beforeError: [
				() => new CustomError(customMessage),
			],
		},
	}));

	t.is(error?.name, 'CustomError');
	t.is(error?.message, customMessage);
	t.true(error instanceof CustomError);
});

test('beforeError can extend RequestError with custom error', async t => {
	class MyCustomError extends RequestError {
		constructor(message: string, error: Error, request: any) {
			super(message, error, request);
			this.name = 'MyCustomError';
		}
	}

	const customMessage = 'Custom RequestError';

	const error = await t.throwsAsync(got('https://example.com', {
		request() {
			throw new Error('Original error');
		},
		hooks: {
			beforeError: [
				error => new MyCustomError(customMessage, error, error.request),
			],
		},
	}));

	t.is(error?.name, 'MyCustomError');
	t.is(error?.message, customMessage);
	t.true(error instanceof MyCustomError);
	t.true(error instanceof RequestError);
});

test('afterResponse retryWithMergedOptions strips sensitive headers on cross-origin retry', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	let evilReceivedCookie: string | undefined;
	evilServer.get('/steal', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		evilReceivedCookie = request.headers.cookie;
		response.end(JSON.stringify({result: 'ok'}));
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({
			retryUrl: `${evilServer.url}/steal`,
		}));
	});

	await got(trustedServer.url + '/api', {
		headers: {
			authorization: 'Bearer SECRET',
			cookie: 'session=s3cr3t',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: new URL(body.retryUrl),
						});
					}

					return response;
				},
			],
		},
	});

	t.is(evilReceivedAuth, undefined);
	t.is(evilReceivedCookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit headers on cross-origin retry', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/api', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end(JSON.stringify({result: 'ok'}));
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({
			retryUrl: `${evilServer.url}/api`,
		}));
	});

	await got(trustedServer.url + '/api', {
		headers: {
			authorization: 'Bearer OLD',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: new URL(body.retryUrl),
							headers: {
								authorization: 'Bearer NEW',
							},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(evilReceivedAuth, 'Bearer NEW');

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions removes explicit undefined headers on cross-origin retry', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer({bodyParser: false});
	let evilReceivedAuth: string | undefined;
	let evilReceivedCookie: string | undefined;
	evilServer.get('/steal', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		evilReceivedCookie = request.headers.cookie;
		response.end(JSON.stringify({result: 'ok'}));
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({
			retryUrl: `${evilServer.url}/steal`,
		}));
	});

	await got(trustedServer.url + '/api', {
		headers: {
			authorization: 'Bearer OLD',
			cookie: 'session=abc',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: new URL(body.retryUrl),
							headers: {
								authorization: undefined,
								cookie: undefined,
							},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(evilReceivedAuth, undefined);
	t.is(evilReceivedCookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips sensitive headers and body after in-place URL mutation', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got.post(trustedServer.url + '/api', {
		headers: {
			authorization: 'Bearer OLD',
			cookie: 'session=abc',
		},
		json: {secret: 'payload'},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const url = response.request.options.url as URL;
						url.protocol = 'http:';
						url.hostname = 'localhost';
						url.port = new URL(body.retryUrl).port;
						url.pathname = '/steal';
						return retryWithMergedOptions({url});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, undefined);
	t.is(received.cookie, undefined);
	t.is(received.body, '');
	t.is(received.contentType, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions supports string url values on cross-origin retry', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({url: body.retryUrl});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions supports relative string url values', withServer, async (t, server, got) => {
	let requestCount = 0;

	server.get('/api', (_request, response) => {
		requestCount++;
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: requestCount === 1}));
	});

	server.get('/retry', (_request, response) => {
		response.end('ok');
	});

	const response = await got('api', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({url: '../retry'});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, 'ok');
	t.is(requestCount, 1);
});

test('afterResponse retryWithMergedOptions can explicitly omit generated authorization', withServer, async (t, server, got) => {
	addRetryHeaderEchoEndpoint(server, 'authorization');

	const response = await got(`http://user:password@localhost:${server.port}/api`, {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								authorization: undefined,
							},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('afterResponse retryWithMergedOptions can explicitly omit generated cookieJar cookies', withServer, async (t, server, got) => {
	addRetryHeaderEchoEndpoint(server, 'cookie');

	const response = await got(`http://localhost:${server.port}/api`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								cookie: undefined,
							},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('afterResponse retryWithMergedOptions clears stale generated cookie when cookieJar is removed', withServer, async (t, server, got) => {
	addRetryHeaderEchoEndpoint(server, 'cookie');

	const response = await got(`http://localhost:${server.port}/api`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							cookieJar: undefined,
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('afterResponse retryWithMergedOptions ignores discarded cookie mutations when disabling cookieJar', withServer, async (t, server, got) => {
	addRetryHeaderEchoEndpoint(server, 'cookie');

	const response = await got(`http://localhost:${server.port}/api`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						response.request.options.headers.cookie = 'session=discarded';
						return retryWithMergedOptions({
							cookieJar: undefined,
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, '');
});

test('afterResponse retryWithMergedOptions preserves explicit cookie when disabling cookieJar', withServer, async (t, server, got) => {
	addRetryHeaderEchoEndpoint(server, 'cookie');

	const response = await got(`http://localhost:${server.port}/api`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							cookieJar: undefined,
							headers: {
								cookie: 'session=from-jar',
							},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, 'session=from-jar');
});

test('afterResponse retryWithMergedOptions supports query-only string url values', withServer, async (t, server, got) => {
	server.get('/api', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		if (searchParameters.get('page') === '2') {
			response.end('ok');
			return;
		}

		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: true}));
	});

	const response = await got('api?page=1', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({url: '?page=2'});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, 'ok');
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with relative string url values', withServer, async (t, server, got) => {
	server.get('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: true}));
	});

	server.get('/protected', (request, response) => {
		response.end(request.headers.authorization ?? '');
	});

	const response = await got('api', {
		username: 'old-user',
		password: 'old-password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({
							url: '../protected',
							username: 'new-user',
							password: 'new-password',
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with query-only string url values', withServer, async (t, server, got) => {
	server.get('/api', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		if (searchParameters.get('page') === '2') {
			const {authorization} = request.headers;
			response.end(authorization ?? '');
			return;
		}

		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: true}));
	});

	const response = await got('api?page=1', {
		username: 'old-user',
		password: 'old-password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({
							url: '?page=2',
							username: 'new-user',
							password: 'new-password',
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with path-relative string url values', withServer, async (t, server, got) => {
	server.get('/items/start', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: true}));
	});

	server.get('/items/next', (request, response) => {
		const {authorization} = request.headers;
		response.end(authorization ?? '');
	});

	const response = await got('items/start', {
		username: 'old-user',
		password: 'old-password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({
							url: 'next',
							username: 'new-user',
							password: 'new-password',
						});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('afterResponse retryWithMergedOptions resolves parent-relative string url values with query params', withServer, async (t, server, got) => {
	server.get('/nested/items/start', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: true}));
	});

	server.get('/nested/target', (request, response) => {
		response.end(request.url);
	});

	const response = await got('nested/items/start', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({url: '../target?page=2'});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, '/nested/target?page=2');
});

test('afterResponse retryWithMergedOptions supports scheme-relative string url values', withServer, async (t, server, got) => {
	server.get('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retry: true}));
	});

	server.get('/scheme-relative', (_request, response) => {
		response.end('ok');
	});

	const response = await got('api', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retry) {
						return retryWithMergedOptions({url: `//localhost:${server.port}/scheme-relative`});
					}

					return response;
				},
			],
		},
	});

	t.is(response.body, 'ok');
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with string url values on cross-origin retry', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'old-user',
		password: 'old-password',
		headers: {
			cookie: 'session=secret',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: body.retryUrl,
							username: 'new-user',
							password: 'new-password',
						});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	t.is(received.cookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions drops body on cross-origin retry', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer({bodyParser: false});
	let evilReceivedBody = '';
	let evilReceivedContentLength: string | undefined;
	let evilReceivedContentType: string | undefined;
	let evilReceivedTransferEncoding: string | undefined;
	evilServer.post('/steal', async (request, response) => {
		evilReceivedBody = await getStream(request);
		evilReceivedContentLength = request.headers['content-length'];
		evilReceivedContentType = request.headers['content-type'];
		evilReceivedTransferEncoding = request.headers['transfer-encoding'];
		response.end(JSON.stringify({result: 'ok'}));
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.post('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({
			retryUrl: `${evilServer.url}/steal`,
		}));
	});

	await got.post(trustedServer.url + '/api', {
		body: 'payload',
		headers: {
			'content-type': 'text/plain',
			'transfer-encoding': 'chunked',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: new URL(body.retryUrl),
						});
					}

					return response;
				},
			],
		},
	});

	t.is(evilReceivedBody, '');
	t.is(evilReceivedContentLength, '0');
	t.is(evilReceivedContentType, undefined);
	t.is(evilReceivedTransferEncoding, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions drops reused async iterable body on cross-origin retry', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer({bodyParser: false});
	let evilReceivedBody = '';
	let evilReceivedContentType: string | undefined;
	evilServer.post('/steal', async (request, response) => {
		evilReceivedBody = await getStream(request);
		evilReceivedContentType = request.headers['content-type'];
		response.end(JSON.stringify({result: 'ok'}));
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.post('/api', async (request, response) => {
		await getStream(request);
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({
			retryUrl: `${evilServer.url}/steal`,
		}));
	});

	async function * generateData() {
		yield 'payload';
	}

	await got.post(trustedServer.url + '/api', {
		body: generateData(),
		headers: {
			'content-type': 'text/plain',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(evilReceivedBody, '');
	t.is(evilReceivedContentType, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit replacement URL credentials when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'old-user',
		password: 'old-password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.url.username = 'new-user';
						updatedOptions.url.password = 'new-password';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves body on same-origin retry', withServer, async (t, server, got) => {
	let requestNumber = 0;
	server.post('/api', async (request, response) => {
		requestNumber++;
		const payload = await getStream(request);

		if (requestNumber === 1) {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({retry: true}));
			return;
		}

		response.end(payload);
	});

	const response = await got.post('api', {
		json: {secret: 'payload'},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if ((response.body as string).includes('"retry":true')) {
						return retryWithMergedOptions({
							url: new URL('/api', response.url),
							headers: {
								token: 'unicorn',
							},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(JSON.parse(response.body).secret, 'payload');
	t.is(requestNumber, 2);
});

test('afterResponse retryWithMergedOptions preserves explicit replacement body on cross-origin retry', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got.post(trustedServer.url + '/api', {
		json: {secret: 'old-payload'},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: new URL(body.retryUrl),
							json: {secret: 'new-payload'},
						});
					}

					return response;
				},
			],
		},
	});

	t.is(JSON.parse(received.body).secret, 'new-payload');
	t.is(received.contentType, 'application/json');

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit URL object credentials on cross-origin retry', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const nextUrl = new URL(response.request.options.url as URL);
						nextUrl.protocol = 'http:';
						nextUrl.hostname = 'localhost';
						nextUrl.port = new URL(body.retryUrl).port;
						nextUrl.pathname = '/steal';
						return retryWithMergedOptions({url: nextUrl});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit URL object username on cross-origin retry', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const nextUrl = new URL(response.request.options.url as URL);
						nextUrl.protocol = 'http:';
						nextUrl.hostname = 'localhost';
						nextUrl.port = new URL(body.retryUrl).port;
						nextUrl.pathname = '/steal';
						return retryWithMergedOptions({url: nextUrl});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips inherited password when explicit URL object keeps only username', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const nextUrl = new URL(response.request.options.url as URL);
						nextUrl.protocol = 'http:';
						nextUrl.hostname = 'localhost';
						nextUrl.port = new URL(body.retryUrl).port;
						nextUrl.pathname = '/steal';
						nextUrl.password = '';
						return retryWithMergedOptions({url: nextUrl});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves same-value credentials on replacement url', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						return retryWithMergedOptions({
							url: `http://user:password@localhost:${new URL(body.retryUrl).port}/steal`,
						});
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit replacement body when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got.post(trustedServer.url + '/api', {
		body: 'old-payload',
		headers: {
			'content-type': 'text/plain',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.body = 'new-payload';
						updatedOptions.headers['content-type'] = 'text/plain';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.body, 'new-payload');
	t.is(received.contentType, 'text/plain');

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips sensitive headers after headers object reassignment on cross-origin retry', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		headers: {
			authorization: 'Bearer secret',
			cookie: 'session=abc',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.headers = {
							...updatedOptions.headers,
							foo: 'bar',
						};
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, undefined);
	t.is(received.cookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves in-place body rewrite when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got.post(trustedServer.url + '/api', {
		body: Buffer.from('old-payload'),
		headers: {
			'content-type': 'text/plain',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						(updatedOptions.body as Uint8Array).set(Buffer.from('new-payload'));
						updatedOptions.headers['content-type'] = 'text/plain';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.body, 'new-payload');
	t.is(received.contentType, 'text/plain');

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves same-value authorization and body when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got.post(trustedServer.url + '/api', {
		body: 'payload',
		headers: {
			authorization: 'Bearer secret',
			'content-type': 'text/plain',
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.headers.authorization = 'Bearer secret';
						updatedOptions.body = 'payload';
						updatedOptions.headers['content-type'] = 'text/plain';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, 'Bearer secret');
	t.is(received.body, 'payload');
	t.is(received.contentType, 'text/plain');

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit replacement credentials when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'old-user',
		password: 'old-password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.username = 'new-user';
						updatedOptions.password = 'new-password';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves same-value credentials when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.username = 'user';
						updatedOptions.password = 'password';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves URL object credentials when reusing request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						updatedOptions.url = new URL(body.retryUrl);
						updatedOptions.url.username = 'user';
						updatedOptions.url.password = 'password';
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips inherited url credentials after in-place cross-origin url mutation', async t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					if (body.retryUrl) {
						const updatedOptions = response.request.options;
						const nextUrl = new URL(body.retryUrl);
						const currentUrl = updatedOptions.url as URL;
						currentUrl.hostname = nextUrl.hostname;
						currentUrl.port = nextUrl.port;
						currentUrl.pathname = nextUrl.pathname;
						currentUrl.protocol = nextUrl.protocol;
						return retryWithMergedOptions(updatedOptions);
					}

					return response;
				},
			],
		},
	});

	t.is(received.authorization, undefined);

	await trustedServer.close();
	await evilServer.close();
});
