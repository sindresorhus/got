import {Buffer} from 'node:buffer';
import {
	Agent as HttpAgent,
	request as httpRequest,
} from 'node:http';
import {PassThrough} from 'node:stream';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import sinon from 'sinon';
import delay from 'delay';
import type {Handler} from 'express';
import Responselike from 'responselike';
import type {Constructor} from 'type-fest';
import got, {
	RequestError,
	HTTPError,
	type NormalizedOptions,
	type Response,
	type OptionsInit,
	type RequestFunction,
} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
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

test('async hooks', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body.foo, 'bar');
});

test('catches init thrown errors', async _t => {
	await assert.rejects(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('catches beforeRequest thrown errors', async _t => {
	await assert.rejects(got('https://example.com', {
		hooks: {
			beforeRequest: [() => {
				throw error;
			}],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('catches beforeRedirect thrown errors', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);
	await assert.rejects(got('redirect', {
		hooks: {
			beforeRedirect: [() => {
				throw error;
			}],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('catches beforeRetry thrown errors', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);
	await assert.rejects(got('retry', {
		hooks: {
			beforeRetry: [() => {
				throw error;
			}],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('throws if afterResponse returns an invalid value', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	await assert.rejects(got('', {
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

test('catches afterResponse thrown errors', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	await assert.rejects(got({
		hooks: {
			afterResponse: [() => {
				throw error;
			}],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('accepts an async function as init hook', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let calls = 0;
	await got('', {
		hooks: {
			init: [
				async () => {
					calls++;
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('catches beforeRequest promise rejections', async _t => {
	await assert.rejects(got('https://example.com', {
		hooks: {
			beforeRequest: [
				async () => {
					throw error;
				},
			],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('catches beforeRedirect promise rejections', withServer, async (_t, server, got) => {
	server.get('/', redirectEndpoint);
	await assert.rejects(got({
		hooks: {
			beforeRedirect: [
				async () => {
					throw error;
				},
			],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('catches beforeRetry promise rejections', withServer, async (_t, server, got) => {
	server.get('/retry', retryEndpoint);
	await assert.rejects(got('retry', {
		hooks: {
			beforeRetry: [
				async () => {
					throw error;
				},
			],
		},
	}), errorMatching(RequestError, {message: errorString}));
});

test('catches afterResponse promise rejections', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	await assert.rejects(got({
		hooks: {
			afterResponse: [
				async () => {
					throw error;
				},
			],
		},
	}), {message: errorString});
});

test('catches beforeError errors', async _t => {
	await assert.rejects(got('https://example.com', {
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

test('init is called with options', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const context = {};
	let calls = 0;
	await got({
		hooks: {
			init: [
				options => {
					calls++;
					assert.deepStrictEqual(options.context, context);
				},
			],
		},
		context,
	});

	assert.strictEqual(calls, 1);
});

test('init from defaults is called with options', withServer, async (_t, server, got) => {
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

	assert.strictEqual(count, 1);
});

test('init allows modifications', withServer, async (_t, server, got) => {
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

	assert.deepStrictEqual(options.headers, {});
	assert.strictEqual(body, 'bar');
});

test('beforeRequest is called with options', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	let calls = 0;
	await got({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				options => {
					calls++;
					const url = options.url!;
					assert.strictEqual(url.pathname, '/');
					assert.strictEqual(url.hostname, 'localhost');
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRequest hook can observe generated authorization header', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	let calls = 0;
	await got(`http://user:password@localhost:${server.port}/`, {
		hooks: {
			beforeRequest: [
				options => {
					calls++;
					assert.strictEqual(options.headers.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRequest hook can observe generated cookieJar header', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	let calls = 0;
	await got(`http://localhost:${server.port}/`, {
		cookieJar: createStaticCookieJar(),
		hooks: {
			beforeRequest: [
				options => {
					calls++;
					assert.strictEqual(options.headers.cookie, 'session=from-jar');
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRequest allows modifications', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body.foo, 'bar');
});

test('beforeRequest allows overriding searchParams with an object', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.url);
	});

	const {body} = await got('', {
		searchParams: {old: 'value'},
		hooks: {
			beforeRequest: [
				options => {
					options.searchParams = {foo: 'bar'};
				},
			],
		},
	});

	assert.strictEqual(body, '/?foo=bar');
});

test('beforeRequest allows overriding searchParams with a string', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.url);
	});

	const {body} = await got('', {
		searchParams: {old: 'value'},
		hooks: {
			beforeRequest: [
				options => {
					options.searchParams = 'foo=bar';
				},
			],
		},
	});

	assert.strictEqual(body, '/?foo=bar');
});

test('beforeRequest is called with context', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	let calls = 0;
	await got({
		hooks: {
			beforeRequest: [
				(_options, context) => {
					calls++;
					assert.ok(context);
					assert.strictEqual(typeof context.retryCount, 'number');
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRequest context has retryCount 0 on initial request', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	let calls = 0;
	await got({
		hooks: {
			beforeRequest: [
				(_options, context) => {
					calls++;
					assert.strictEqual(context.retryCount, 0);
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRequest context retryCount increments on retries', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	const retryCounts: number[] = [];
	await assert.rejects(got({
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
	}), HTTPError);

	assert.strictEqual(retryCounts.length, 3);
	assert.strictEqual(retryCounts[0], 0); // Initial request
	assert.strictEqual(retryCounts[1], 1); // First retry
	assert.strictEqual(retryCounts[2], 2); // Second retry
});

test('returning HTTP response from a beforeRequest hook', withServer, async (_t, server, got) => {
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

	assert.strictEqual(statusCode, 200);
	assert.strictEqual(headers.foo, 'bar');
	assert.strictEqual(body, 'Hi!');
});

test('returning HTTP response from a beforeRequest hook with FormData body', withServer, async (_t, server, got) => {
	server.post('/', echoBody);

	const form = new FormData();
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

	assert.strictEqual(data.cached, 'response');
});

test('returning HTTP response from a beforeRequest hook with large buffer body', withServer, async (_t, server, got) => {
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

	assert.strictEqual(body, 'hooked');
});

test('returning HTTP response from a beforeRequest hook with large json body', withServer, async (_t, server, got) => {
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

	assert.strictEqual(data.cached, 'json');
});

test('returning HTTP response from a beforeRequest hook with large typed array body', withServer, async (_t, server, got) => {
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

	assert.strictEqual(body, 'typed-array');
});

test('returning HTTP response from a beforeRequest hook can observe generated cookieJar header', withServer, async (_t, _server, got) => {
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
					assert.strictEqual(options.headers.cookie, 'session=from-jar');

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

	assert.strictEqual(body, 'cached');
});

test('returning HTTP response from a beforeRequest hook ignores conflicting transfer headers', withServer, async (_t, server, got) => {
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

	assert.strictEqual(body, 'cached');
});

test('beforeRedirect is called with options and response', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);
	let calls = 0;
	await got('redirect', {
		responseType: 'json',
		hooks: {
			beforeRedirect: [
				(options, response) => {
					calls++;
					const url = options.url!;
					assert.strictEqual(url.pathname, '/');
					assert.strictEqual(url.hostname, 'localhost');

					assert.strictEqual(response.statusCode, 302);
					assert.strictEqual(new URL(response.url).pathname, '/redirect');
					assert.strictEqual(response.redirectUrls.length, 1);
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRedirect allows modifications', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body.foo, 'bar');
});

test('returning HTTP response from a beforeRequest hook skips basic auth generation', withServer, async (_t, server, got) => {
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

	assert.strictEqual(body, 'cached');
});

test('beforeRedirect hook can explicitly omit generated authorization', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('beforeRedirect hook can explicitly omit generated cookieJar cookies', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('beforeRedirect hook clears stale generated cookie when cookieJar is removed', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('beforeRetry is called with options', withServer, async (_t, server) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	const context = {};
	let calls = 0;
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
					calls++;
					const {options} = error;
					const {retryCount: requestRetryCount} = error.request!;
					assert.strictEqual((options.url as URL).hostname, 'localhost');
					assert.deepStrictEqual(options.context, context);
					assert.ok(error);
					assert.strictEqual(requestRetryCount, 0);
					assert.strictEqual(retryCount, 1);
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('beforeRetry allows modifications', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body.foo, 'bar');
});

test('beforeRetry allows stream body if different from original', withServer, async (_t, server, got) => {
	server.post('/retry', async (request, response) => {
		if (request.headers.foo) {
			response.send('test');
		} else {
			response.statusCode = 500;
		}

		response.end();
	});

	const generateBody = () => {
		const form = new FormData();
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

	assert.strictEqual(body, 'test');
});

test('prefixUrl is preserved in beforeRequest hook', withServer, async (_t, server, got) => {
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

	const normalizedServerUrl = new URL(server.url).href;
	assert.strictEqual(capturedPrefixUrl, normalizedServerUrl);
});

test('beforeRequest prefixUrl rewrite drops inherited generated credentials cross-origin', withServer, async (_t, server, got) => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/items', 'success');

	try {
		const {body} = await got('items', {
			prefixUrl: server.url,
			username: 'old-user',
			password: 'old-password',
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = evilServer.url;
					},
				],
			},
		});

		assert.strictEqual(body, 'success');
		assert.strictEqual(received.method, 'GET');
		assert.strictEqual(received.url, '/items');
		assert.strictEqual(received.authorization, undefined);
	} finally {
		await evilServer.close();
	}
});

test('beforeRequest prefixUrl rewrite strips inherited sensitive headers and body cross-origin', withServer, async (_t, server, got) => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/items', 'success');

	try {
		const {body} = await got.post('items', {
			prefixUrl: server.url,
			json: {secret: 'payload'},
			headers: {
				authorization: 'Bearer secret',
				cookie: 'session=secret',
			},
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = evilServer.url;
					},
				],
			},
		});

		assert.strictEqual(body, 'success');
		assert.strictEqual(received.method, 'POST');
		assert.strictEqual(received.url, '/items');
		assert.strictEqual(received.authorization, undefined);
		assert.strictEqual(received.cookie, undefined);
		assert.strictEqual(received.body, '');
		assert.strictEqual(received.contentType, undefined);
	} finally {
		await evilServer.close();
	}
});

test('beforeRequest prefixUrl rewrite drops writable stream body cross-origin', withServer, async (_t, server, got) => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/items', 'success');

	try {
		const stream = got.stream.post('items', {
			prefixUrl: server.url,
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = evilServer.url;
					},
				],
			},
		});

		stream.end('stream-secret');

		assert.strictEqual(await getStream(stream), 'success');
		assert.strictEqual(received.method, 'POST');
		assert.strictEqual(received.url, '/items');
		assert.strictEqual(received.body, '');
	} finally {
		await evilServer.close();
	}
});

test('beforeRequest prefixUrl rewrite preserves replacement body and drops writable stream body cross-origin', withServer, async (_t, server, got) => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/items', 'success');
	const replacementBody = 'replacement'.repeat(20_000);

	try {
		const stream = got.stream.post('items', {
			prefixUrl: server.url,
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = evilServer.url;
						options.body = replacementBody;
					},
				],
			},
		});

		stream.end('stream-secret');

		assert.strictEqual(await getStream(stream), 'success');
		assert.strictEqual(received.method, 'POST');
		assert.strictEqual(received.url, '/items');
		assert.strictEqual(received.body, replacementBody);
	} finally {
		await evilServer.close();
	}
});

test('beforeRequest prefixUrl rewrite drops late writable stream body before redirect cross-origin', withServer, async (_t, server, got) => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;
	const evilServer = await createHttpTestServer({bodyParser: false});
	let initialBody = '';
	let receivedBody = '';

	evilServer.post('/items', async (request, response) => {
		initialBody = await getStream(request);
		response.statusCode = 307;
		response.setHeader('location', '/final');
		response.end();
	});

	evilServer.post('/final', async (request, response) => {
		receivedBody = await getStream(request);
		response.end('success');
	});

	try {
		const stream = got.stream.post('items', {
			prefixUrl: server.url,
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = evilServer.url;
					},
				],
			},
		});

		stream.once('request', () => {
			stream.end('stream-secret');
		});

		assert.strictEqual(await getStream(stream), 'success');
		assert.strictEqual(initialBody, '');
		assert.strictEqual(receivedBody, '');
	} finally {
		await evilServer.close();
	}
});

test('beforeRequest prefixUrl rewrite does not inherit password when only username is explicit', withServer, async (_t, server, got) => {
	server.get('/v2/items', echoHeader('authorization'));

	const nextPrefixUrl = new URL(server.url);
	nextPrefixUrl.username = 'new-user';
	nextPrefixUrl.pathname = '/v2/';

	const {body} = await got('items', {
		prefixUrl: server.url,
		username: 'old-user',
		password: 'old-password',
		hooks: {
			beforeRequest: [
				options => {
					options.prefixUrl = nextPrefixUrl.href;
				},
			],
		},
	});

	assert.strictEqual(body, `Basic ${Buffer.from('new-user:').toString('base64')}`);
});

test('prefixUrl is preserved in beforeRetry hook', withServer, async (_t, server, got) => {
	server.get('/retry', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let capturedPrefixUrl: string | URL | undefined;
	await assert.rejects(got('retry', {
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

	const normalizedServerUrl = new URL(server.url).href;
	assert.strictEqual(capturedPrefixUrl, normalizedServerUrl);
});

test('setting absolute URL in hook does not concatenate with prefixUrl', withServer, async (_t, server, got) => {
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

	assert.strictEqual(body, 'changed');
});

test('allowAbsoluteUrls false rejects absolute URL set in hook when prefixUrl is set', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		prefixUrl: server.url,
		hooks: {
			beforeRequest: [
				options => {
					options.url = new URL(`${server.url}/changed`);
				},
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects in-place URL mutation from beforeRequest hook outside prefixUrl origin', withServer, async (_t, server, got) => {
	server.get('/api/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		prefixUrl: `${server.url}/api`,
		hooks: {
			beforeRequest: [
				options => {
					options.url!.hostname = 'example.com';
				},
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
});

test('allowAbsoluteUrls false rejects beforeRequest prefixUrl mutation around absolute URL', withServer, async (t, server, got) => {
	await withServer(t, async (_t, absoluteServer) => {
		absoluteServer.get('/original', (_request, response) => {
			response.end('original');
		});
		await assert.rejects(got(`${absoluteServer.url}/original`, {
			allowAbsoluteUrls: false,
			prefixUrl: '',
			hooks: {
				beforeRequest: [
					options => {
						options.prefixUrl = server.url;
					},
				],
			},
		}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
	});
});

test('allowAbsoluteUrls false rejects absolute URL from retryWithMergedOptions when prefixUrl is set', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: `${server.url}/changed`,
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects URL instance from retryWithMergedOptions when prefixUrl is set', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: new URL(`${server.url}/changed`),
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects in-place URL mutation from retryWithMergedOptions outside prefixUrl origin', withServer, async (_t, server, got) => {
	server.get('/api/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		prefixUrl: `${server.url}/api`,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const {options} = response.request;
					(options.url as URL).hostname = 'example.com';
					return retryWithMergedOptions(options);
				},
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
});

test('allowAbsoluteUrls false rejects live URL mutation with partial retryWithMergedOptions outside prefixUrl origin', withServer, async (_t, server, got) => {
	server.get('/api/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		prefixUrl: `${server.url}/api`,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const {options} = response.request;
					(options.url as URL).hostname = 'example.com';
					return retryWithMergedOptions({
						headers: {
							'x-retry': 'true',
						},
					});
				},
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
});

test('allowAbsoluteUrls false rejects retryWithMergedOptions prefixUrl mutation around absolute URL', withServer, async (t, server, got) => {
	await withServer(t, async (_t, absoluteServer) => {
		absoluteServer.get('/original', (_request, response) => {
			response.end('original');
		});
		await assert.rejects(got(`${absoluteServer.url}/original`, {
			allowAbsoluteUrls: false,
			prefixUrl: '',
			hooks: {
				afterResponse: [
					(_response, retryWithMergedOptions) => retryWithMergedOptions({
						prefixUrl: server.url,
					}),
				],
			},
		}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
	});
});

test('allowAbsoluteUrls false rejects scheme-relative URL from retryWithMergedOptions when prefixUrl is set', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: `//localhost:${server.port}/changed`,
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects backslash scheme-relative URL from retryWithMergedOptions', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: String.raw`\\example.com/changed`,
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects http URL without slashes from retryWithMergedOptions when prefixUrl is set', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: 'http:example.com',
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects whitespace-prefixed scheme-relative URL from retryWithMergedOptions', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: '\t//example.com/changed',
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects C0-control-prefixed absolute URL from retryWithMergedOptions', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: '\u{0}https://example.com/changed',
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects ASCII-newline-normalized absolute URL from retryWithMergedOptions', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.end('original');
	});
	await assert.rejects(got('original', {
		allowAbsoluteUrls: false,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: 'h\nttps://example.com/changed',
				}),
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('allowAbsoluteUrls false rejects whitespace-prefixed scheme-relative URL from retryWithMergedOptions after redirect', withServer, async (t, server, got) => {
	await withServer(t, async (_t, redirectServer) => {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: `${redirectServer.url}/target`,
			});
			response.end();
		});

		redirectServer.get('/target', (_request, response) => {
			response.end('target');
		});
		await assert.rejects(got('redirect', {
			allowAbsoluteUrls: false,
			hooks: {
				afterResponse: [
					(_response, retryWithMergedOptions) => retryWithMergedOptions({
						url: '\t//example.com/changed',
					}),
				],
			},
		}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
	});
});

test('allowAbsoluteUrls false allows retryWithMergedOptions after cross-origin redirect without URL mutation', withServer, async (t, server, got) => {
	await withServer(t, async (_t, redirectServer) => {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: `${redirectServer.url}/target`,
			});
			response.end();
		});

		redirectServer.get('/target', (request, response) => {
			response.end(request.headers['x-retry'] === 'true' ? 'retried' : 'first');
		});

		const {body} = await got('redirect', {
			allowAbsoluteUrls: false,
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => {
						if (response.body === 'first') {
							return retryWithMergedOptions({
								headers: {
									'x-retry': 'true',
								},
							});
						}

						return response;
					},
				],
			},
		});

		assert.strictEqual(body, 'retried');
	});
});

test('afterResponse retryWithMergedOptions supports empty string url value', withServer, async (_t, server, got) => {
	server.get('/original', (request, response) => {
		response.end(request.headers['x-retry'] === 'true' ? 'retried' : 'original');
	});

	const response = await got('original', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'original') {
						return retryWithMergedOptions({
							url: '',
							headers: {
								'x-retry': 'true',
							},
						});
					}

					return response;
				},
			],
		},
	});

	assert.strictEqual(response.body, 'retried');
});

test('allows colon in path segment with prefixUrl (CouchDB user URLs)', withServer, async (_t, server, serverGot) => {
	server.get('/_users/org.couchdb.user:test@user.com', (_request, response) => {
		response.end('user document');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/_users/`,
	});

	const {body} = await client.get('org.couchdb.user:test@user.com');
	assert.strictEqual(body, 'user document');
});

test('allows multiple colons in path with prefixUrl', withServer, async (_t, server, serverGot) => {
	server.get(/^\/api\/ns:type:id$/v, (_request, response) => {
		response.end('namespaced');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/api/`,
	});

	const {body} = await client.get('ns:type:id');
	assert.strictEqual(body, 'namespaced');
});

test('allows mailto-like patterns in path with prefixUrl', withServer, async (_t, server, serverGot) => {
	server.get('/users/mailto:test@example.com', (_request, response) => {
		response.end('email user');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/users/`,
	});

	const {body} = await client.get('mailto:test@example.com');
	assert.strictEqual(body, 'email user');
});

test('allows URN-like patterns in path with prefixUrl', withServer, async (_t, server, serverGot) => {
	server.get(/^\/resources\/urn:isbn:123$/v, (_request, response) => {
		response.end('book');
	});

	const client = serverGot.extend({
		prefixUrl: `${server.url}/resources/`,
	});

	const {body} = await client.get('urn:isbn:123');
	assert.strictEqual(body, 'book');
});

test('afterResponse is called with response', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);
	let calls = 0;
	await got({
		responseType: 'json',
		hooks: {
			afterResponse: [
				response => {
					calls++;
					assert.strictEqual(typeof response.body, 'object');

					return response;
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('afterResponse allows modifications', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body.hello, 'world');
});

test('followRedirect is evaluated for a replacement response returned by afterResponse', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/stop'});
		response.end();
	});

	let calls = 0;
	await assert.rejects(got({
		followRedirect(response) {
			calls++;
			return response.headers.location === '/follow';
		},
		hooks: {
			afterResponse: [response => {
				const replacementResponse = Object.assign(Object.create(response) as typeof response, {
					headers: {
						...response.headers,
						location: '/follow',
					},
				});

				return replacementResponse;
			}],
		},
	}), HTTPError);
	assert.strictEqual(calls, 2);
});

test('afterResponse allows to retry', withServer, async (_t, server, got) => {
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
	assert.strictEqual(statusCode, 200);
});

test('afterResponse allows to retry without losing the port', withServer, async (_t, server) => {
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
	assert.strictEqual(statusCode, 200);
});

test('cancelling the request after retrying in a afterResponse hook', withServer, async (_t, server, got) => {
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
	await assert.rejects(gotPromise);
	await delay(100);
	assert.strictEqual(requests, 1);
});

test('afterResponse allows to retry - `beforeRetry` hook', withServer, async (_t, server, got) => {
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
					assert.ok(options);
					isCalled = true;
				},
			],
		},
	});
	assert.strictEqual(statusCode, 200);
	assert.strictEqual(isCalled, true);
});

test('no infinity loop when retrying on afterResponse', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});
	await assert.rejects(got({
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
	}), errorMatching(HTTPError, {message: /^Request failed with status code 401 \(Unauthorized\): GET http:\/\/localhost:\d+\/$/v}));
});

test('throws on afterResponse retry failure', withServer, async (_t, server, got) => {
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
	await assert.rejects(got({
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
	}), errorMatching(HTTPError, {message: /^Request failed with status code 500 \(Internal Server Error\): GET http:\/\/localhost:\d+\/$/v}));
});

test('does not throw on afterResponse retry HTTP failure if throwHttpErrors is false', withServer, async (_t, server, got) => {
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
	assert.strictEqual(statusCode, 500);
});

test('afterResponse preserveHooks keeps remaining hooks on retry', withServer, async (_t, server, got) => {
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

	assert.strictEqual(statusCode, 200);
	assert.strictEqual(firstHookCalls, 2); // Called for both original and retry
	assert.strictEqual(secondHookCalls, 1); // Called only on retry (original was interrupted by RetryError)
});

test('afterResponse without preserveHooks skips remaining hooks on retry', withServer, async (_t, server, got) => {
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

	assert.strictEqual(statusCode, 200);
	assert.strictEqual(firstHookCalls, 1); // Called only on original request (removed from retry by default)
	assert.strictEqual(secondHookCalls, 0); // Never called (removed by slice before it could run)
});

test('afterResponse preserveHooks with three hooks', withServer, async (_t, server, got) => {
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

	assert.strictEqual(statusCode, 200);
	assert.strictEqual(firstHookCalls, 2); // Called for both original and retry
	assert.strictEqual(secondHookCalls, 1); // Called only on retry
	assert.strictEqual(thirdHookCalls, 1); // Called only on retry
});

test('afterResponse preserveHooks when second hook triggers retry', withServer, async (_t, server, got) => {
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

	assert.strictEqual(statusCode, 200);
	assert.strictEqual(firstHookCalls, 2); // Called for both original and retry (preserved by preserveHooks)
	assert.strictEqual(secondHookCalls, 2); // Called for both original and retry
	assert.strictEqual(thirdHookCalls, 1); // Called only on retry
});

test('throwing in a beforeError hook - promise', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	await assert.rejects(got({
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

test('throwing in a beforeError hook - stream', withServer, async (_t, _server, got) => {
	await assert.rejects(getStream(got.stream({
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

test('beforeError is called with an error - promise', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let capturedError2: unknown;
	await assert.rejects(got({
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

	assert.strictEqual(capturedError2 instanceof Error, true);
});

test('beforeError is called with an error - stream', withServer, async (_t, _server, got) => {
	let capturedError2: unknown;
	await assert.rejects(getStream(got.stream({
		hooks: {
			beforeError: [error2 => {
				capturedError2 = error2;
				return error2;
			}],
		},
	})), {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v});

	assert.strictEqual(capturedError2 instanceof Error, true);
});

test('beforeError allows modifications', async _t => {
	const errorString2 = 'foobar';
	await assert.rejects(got('https://example.com', {
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

test('does not break on `afterResponse` hook with JSON mode', withServer, async (_t, server, got) => {
	server.get('/foobar', echoHeaders);
	await assert.doesNotReject(got('', {
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

test('catches HTTPErrors', withServer, async (_t, _server, got) => {
	let capturedError: unknown;
	await assert.rejects(got({
		hooks: {
			beforeError: [
				error => {
					capturedError = error;
					return error;
				},
			],
		},
	}));

	assert.strictEqual(capturedError instanceof HTTPError, true);
});

test('timeout can be modified using a hook', withServer, async (_t, server, got) => {
	server.get('/', () => {});
	await assert.rejects(got({
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

test('beforeRequest hook is called before each request', withServer, async (_t, server, got) => {
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
					assert.strictEqual(options.headers['content-length'], String(buffer.length));
				},
			],
		},
	});

	assert.strictEqual(counts, 2);
});

test('beforeError emits valid promise `HTTPError`s', withServer, async (_t, server, got) => {
	let beforeErrorCalls = 0;
	let hookError: unknown;

	server.get('/', (_request, response) => {
		response.writeHead(422);
		response.end('no');
	});

	const instance = got.extend({
		hooks: {
			beforeError: [
				error => {
					beforeErrorCalls += 1;
					hookError = error;

					return error;
				},
			],
		},
		retry: {
			limit: 0,
		},
	});
	const error = await rejects<HTTPError>(instance(''), HTTPError);

	assert.strictEqual(beforeErrorCalls, 1);
	assert.strictEqual(hookError, error);
	assert.ok(error.response.body);
});

test('hooks are not duplicated', withServer, async (_t, _server, got) => {
	let calls = 0;
	await assert.rejects(got({
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

	assert.strictEqual(calls, 1);
});

test('async afterResponse allows to retry with allowGetBody and json payload', withServer, async (_t, server, got) => {
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
				(response, retryWithMergedOptions) => response.statusCode === 401 ? retryWithMergedOptions({headers: {token: 'unicorn'}}) : response,
			],
		},
		retry: {
			limit: 0,
		},
		throwHttpErrors: false,
	});

	assert.strictEqual(statusCode, 200);
});

test('beforeRequest hook respect `agent` option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent} = createAgentSpy(HttpAgent);

	assert.ok((await got({
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

test('beforeRequest hook respect `url` option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ko');
	});

	server.get('/changed', (_request, response) => {
		response.end('ok');
	});

	assert.strictEqual((await got(server.hostname, {
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
	await withServer(t, async (_t, server2) => {
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

		assert.strictEqual(cookie, 'target=server2');
	});
});

test('beforeRequest hook can explicitly omit cookieJar cookies when changing URL', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
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
						options.headers.cookie = undefined;
					},
				],
			},
		}).json<{cookie?: string}>();

		assert.strictEqual(cookie, undefined);
	});
});

test('beforeRequest hook refreshes basic auth when changing URL credentials', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
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

		assert.strictEqual(authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	});
});

test('beforeRequest hook can explicitly omit authorization when changing URL credentials', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
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
						options.headers.authorization = undefined;
					},
				],
			},
		}).json<{authorization?: string}>();

		assert.strictEqual(authorization, undefined);
	});
});

test('beforeRequest hook omits authorization after deleting explicit authorization and changing URL credentials', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
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

		assert.strictEqual(authorization, undefined);
	});
});

test('beforeRequest hook drops conflicting content-length when transfer-encoding is added', withServer, async (_t, server, got) => {
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
	assert.strictEqual(headers['transfer-encoding'], 'chunked');
	assert.strictEqual(headers['content-length'], undefined);
});

test('beforeRequest hook clears generated basic auth when credentials are removed', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, undefined);
});

test('beforeRequest hook preserves explicit authorization header when clearing URL credentials', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, 'Bearer replacement-token');
});

test('beforeRequest hook preserves same-value authorization header when clearing URL credentials', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, authorizationHeader);
});

test('beforeRequest hook preserves explicit authorization override when URL credentials remain', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, 'Bearer replacement-token');
});

test('beforeRequest hook can delete an explicit authorization header without restoring it', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('beforeRequest hook omits authorization for custom requests after deleting explicit override and changing credentials', withServer, async (_t, server, got) => {
	server.get('/', echoHeader('authorization'));

	const request: RequestFunction = (url, options, callback) => {
		assert.strictEqual((options.headers as Record<string, string | undefined> | undefined)?.authorization, undefined);
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

	assert.strictEqual(response.body, '');
});

test('beforeRequest hook regenerates authorization header for custom requests after changing credentials', withServer, async (_t, server, got) => {
	server.get('/', echoHeader('authorization'));

	const request: RequestFunction = (url, options, callback) => {
		assert.strictEqual((options.headers as Record<string, string | undefined> | undefined)?.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
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

	assert.strictEqual(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('beforeRequest hook can explicitly omit generated authorization', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, undefined);
});

test('beforeRequest hook can replace initially omitted authorization', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, 'Bearer replacement-token');
});

test('beforeRequest hook can explicitly omit generated cookieJar cookies', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, undefined);
});

test('beforeRequest hook can replace initially omitted cookie header', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, 'session=replaced');
});

test('beforeRequest hook can omit generated authorization for a single retry attempt', withServer, async (_t, server, got) => {
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

	assert.strictEqual(authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
});

test('beforeRequest hook can omit generated cookieJar cookies for a single retry attempt', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, 'session=from-jar');
});

test('beforeRequest hook preserves same-value cookie header when removing cookieJar', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, 'session=from-jar');
});

test('beforeRequest hook preserves explicit cookie override when cookieJar remains', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, 'session=override');
});

test('beforeRequest hook preserves initial explicit cookie when disabling cookieJar', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, 'session=from-jar');
});

test('beforeRequest hook clears stale generated cookie when cookieJar is removed', withServer, async (_t, server, got) => {
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

	assert.strictEqual(cookie, undefined);
});

test('beforeRequest hook clears stale cookieJar cookie when changing URL to a cookie-less destination', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
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

		assert.strictEqual(cookie, undefined);
	});
});

test('no duplicate hook calls in single-page paginated requests', withServer, async (_t, server, got) => {
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
	assert.strictEqual(beforeHookCount, 1);
	assert.strictEqual(afterHookCount, 1);
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
	assert.strictEqual(beforeHookCount, 2);
	assert.strictEqual(afterHookCount, 2);
	assert.strictEqual(beforeHookCountAdditional, 1);
	assert.strictEqual(afterHookCountAdditional, 1);
	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate: () => false,
			transform: response => [response],
		},
	});

	assert.strictEqual(beforeHookCount, 3);
	assert.strictEqual(afterHookCount, 3);
});

test('no duplicate hook calls in sequential paginated requests', withServer, async (_t, server, got) => {
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

	assert.strictEqual(beforeHookCount, 2);
	assert.strictEqual(afterHookCount, 2);
	requestNumber = 0;
	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			transform: response => [response],
		},
	});

	assert.strictEqual(beforeHookCount, 4);
	assert.strictEqual(afterHookCount, 4);
});

test('intentional duplicate hooks in pagination with extended instance', withServer, async (_t, server, got) => {
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

	assert.strictEqual(beforeCount, 3);
	assert.strictEqual(afterCount, 3);
	assert.strictEqual(beforeCountAdditional, 2);
	assert.strictEqual(afterCountAdditional, 2);
});

test('no duplicate hook calls when returning original request options', withServer, async (_t, server, got) => {
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

	assert.strictEqual(beforeHookCount, 2);
	assert.strictEqual(afterHookCount, 2);
	requestNumber = 0;
	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			transform: response => [response],
		},
	});

	assert.strictEqual(beforeHookCount, 4);
	assert.strictEqual(afterHookCount, 4);
});

test('`beforeRequest` change body', withServer, async (_t, server, got) => {
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

	assert.strictEqual(JSON.parse(response.body).payload, 'new');
});

test('`beforeRequest` change body with multi-byte characters', withServer, async (_t, server, got) => {
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

	assert.strictEqual(JSON.parse(response.body).payload, 'new 🦄 café');
});

test('can retry without an agent', withServer, async (_t, server, got) => {
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

	const {response} = (await rejects(got({
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

	assert.strictEqual(response.retryCount, 2);
	assert.strictEqual(counter, 1);
});

test('does not throw on empty body when running afterResponse hooks', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});
	await assert.doesNotReject(got('', {
		hooks: {
			afterResponse: [
				response => response,
			],
		},
	}));
});

test('does not throw on null body with afterResponse hook and responseType json', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body, null);
});

test('does not throw on null body with afterResponse hook and responseType json - resolveBodyOnly', withServer, async (_t, server, got) => {
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
	assert.strictEqual(body, null);
});

test('does not call beforeError hooks on falsy throwHttpErrors', withServer, async (_t, server, got) => {
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

	assert.strictEqual(called, false);
});

test('beforeError hook is called for ERR_UNSUPPORTED_PROTOCOL', async _t => {
	let hookCalled = false;

	const beforeErrorHook = (error: RequestError) => {
		hookCalled = true;
		return error;
	};

	await assert.rejects(
		got.post('xhttps://example.com', {
			headers: {authorization: 'Bearer secret'},
			json: {foo: 42},
			hooks: {
				beforeError: [beforeErrorHook],
			},
		}),
		{code: 'ERR_UNSUPPORTED_PROTOCOL'},
	);

	assert.strictEqual(hookCalled, true);
});

test('beforeError hook can redact sensitive headers for ERR_UNSUPPORTED_PROTOCOL', async _t => {
	const redactAuthorizationHeader = (error: RequestError) => {
		if (error.options?.headers?.authorization) {
			error.options.headers.authorization = '<redacted>';
		}

		return error;
	};

	const error = await rejects(
		got.post('xhttps://example.com/some/resource', {
			headers: {authorization: 'Bearer secret'},
			json: {foo: 42},
			hooks: {
				beforeError: [redactAuthorizationHeader],
			},
		}),
		{code: 'ERR_UNSUPPORTED_PROTOCOL'},
	);

	assert.strictEqual(error?.options.headers.authorization, '<redacted>');
});

test('beforeRetry can reassign plain stream body', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.body, `Received: ${testData}`);
	assert.strictEqual(requestCount, 2);
});

test('beforeRetry destroys old stream when reassigning body', withServer, async (_t, server, got) => {
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

	assert.strictEqual(oldStreamDestroyed, true, 'Old stream should be destroyed to prevent memory leak');
	assert.strictEqual(requestCount, 2);
});

test('beforeRetry cancels old Web ReadableStream when reassigning body', withServer, async (_t, server, got) => {
	let requestCount = 0;
	let cancelled = false;

	server.post('/retry', async (request, response) => {
		requestCount++;
		if (requestCount === 1) {
			request.once('data', () => {
				request.socket.destroy();
			});
			return;
		}

		response.end(await getStream(request));
	});

	const originalBody = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('initial body'));
		},
		cancel() {
			cancelled = true;
		},
	});

	const response = await got.post('retry', {
		body: originalBody,
		retry: {
			limit: 1,
			methods: ['POST'],
			calculateDelay: () => 1,
		},
		hooks: {
			beforeRetry: [
				({options}) => {
					options.body = 'retry body';
				},
			],
		},
	});

	assert.strictEqual(response.body, 'retry body');
	assert.strictEqual(cancelled, true);
	assert.strictEqual(originalBody.locked, false);
});

test('beforeRetry handles multiple retries with stream reassignment', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.body, `Received: ${testData}`);
	assert.strictEqual(requestCount, 3);
	assert.strictEqual(destroyedStreams.length, 2, 'All old streams should be destroyed');
});

test('beforeRetry routes invalid reassigned stream body through normal error handling', withServer, async (_t, server, got) => {
	let requestCount = 0;

	server.post('/retry', async (request, response) => {
		requestCount++;
		await request.toArray();

		response.statusCode = 500;
		response.end('Server Error');
	});

	const error = await rejects(got.post('retry', {
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

	assert.ok(error);
	assert.strictEqual(requestCount, 1);
});

test('beforeRetry accepts ended pass-through stream reassignment', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, 'payload');
	assert.strictEqual(requestCount, 2);
});

test('beforeRetry handles non-stream body reassignment', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.body, 'Received: retried body');
	assert.strictEqual(requestCount, 2);
});

test('beforeRetry handles body set to undefined', withServer, async (_t, server, got) => {
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

	assert.strictEqual(requestCount, 2);
});

test('beforeRetry handles body from undefined to stream', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, 'Got: stream-data');
	assert.strictEqual(requestCount, 2);
});

test('beforeRetry handles stream to Buffer conversion', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, 'Got: buffer-data');
	assert.strictEqual(requestCount, 2);
});

test('handler error is properly thrown in .json()', withServer, async (_t, _server, got) => {
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
	await assert.rejects(instance('').json(), {message: 'Custom handler error'});
});

test('handler error is properly thrown in .text()', withServer, async (_t, _server, got) => {
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
	await assert.rejects(instance('').text(), {message: 'Custom handler error for text'});
});

test('handler error is properly thrown in .buffer()', withServer, async (_t, _server, got) => {
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
	await assert.rejects(instance('').buffer(), {message: 'Custom handler error for buffer'});
});

test('handler throwing on successful response works with .json()', withServer, async (_t, server, got) => {
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
	await assert.rejects(instance('').json(), {message: 'Handler rejected success'});
});

test('multiple handlers with error transformation work with .json()', withServer, async (_t, _server, got) => {
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
	await assert.rejects(instance('').json(), {message: /Handler 1: Handler 2:/v});
});

test('beforeError can return custom Error class', async _t => {
	class CustomError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'CustomError';
		}
	}

	const customMessage = 'This is a custom error';

	const error = await rejects(got('https://example.com', {
		request() {
			throw new Error('Original error');
		},
		hooks: {
			beforeError: [
				() => new CustomError(customMessage),
			],
		},
	}));

	assert.strictEqual(error?.name, 'CustomError');
	assert.strictEqual(error?.message, customMessage);
	assert.strictEqual(error instanceof CustomError, true);
});

test('beforeError can extend RequestError with custom error', async _t => {
	class MyCustomError extends RequestError {
		constructor(message: string, error: Error, request: any) {
			super(message, error, request);
			this.name = 'MyCustomError';
		}
	}

	const customMessage = 'Custom RequestError';

	const error = await rejects(got('https://example.com', {
		request() {
			throw new Error('Original error');
		},
		hooks: {
			beforeError: [
				error => new MyCustomError(customMessage, error, error.request),
			],
		},
	}));

	assert.strictEqual(error?.name, 'MyCustomError');
	assert.strictEqual(error?.message, customMessage);
	assert.strictEqual(error instanceof MyCustomError, true);
	assert.strictEqual(error instanceof RequestError, true);
});

test('afterResponse retryWithMergedOptions strips sensitive headers on cross-origin retry', async _t => {
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

	assert.strictEqual(evilReceivedAuth, undefined);
	assert.strictEqual(evilReceivedCookie, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips sensitive headers and body when changing prefixUrl cross-origin', async _t => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/api');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/api`);

	try {
		await got.post('api', {
			prefixUrl: trustedServer.url,
			json: {secret: 'payload'},
			headers: {
				authorization: 'Bearer secret',
				cookie: 'session=secret',
			},
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => {
						const body = JSON.parse(response.body as string);
						if (body.retryUrl) {
							return retryWithMergedOptions({
								prefixUrl: evilServer.url,
							});
						}

						return response;
					},
				],
			},
		});

		assert.strictEqual(received.method, 'POST');
		assert.strictEqual(received.url, '/api');
		assert.strictEqual(received.authorization, undefined);
		assert.strictEqual(received.cookie, undefined);
		assert.strictEqual(received.body, '');
		assert.strictEqual(received.contentType, undefined);
	} finally {
		await trustedServer.close();
		await evilServer.close();
	}
});

test('afterResponse retryWithMergedOptions preserves explicit prefixUrl credentials on cross-origin retry', async _t => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/api');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/api`);
	const nextPrefixUrl = new URL(evilServer.url);
	nextPrefixUrl.username = 'new-user';
	nextPrefixUrl.password = 'new-password';

	try {
		await got('api', {
			prefixUrl: trustedServer.url,
			username: 'old-user',
			password: 'old-password',
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => {
						const body = JSON.parse(response.body as string);
						if (body.retryUrl) {
							return retryWithMergedOptions({
								prefixUrl: nextPrefixUrl,
							});
						}

						return response;
					},
				],
			},
		});

		assert.strictEqual(received.method, 'GET');
		assert.strictEqual(received.url, '/api');
		assert.strictEqual(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	} finally {
		await trustedServer.close();
		await evilServer.close();
	}
});

test('afterResponse retryWithMergedOptions strips sensitive headers and body when reusing request options with cross-origin prefixUrl', async _t => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/api');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/api`);

	try {
		await got.post('api', {
			prefixUrl: trustedServer.url,
			json: {secret: 'payload'},
			headers: {
				authorization: 'Bearer secret',
				cookie: 'session=secret',
			},
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => {
						const body = JSON.parse(response.body as string);
						if (body.retryUrl) {
							const updatedOptions = response.request.options;
							updatedOptions.prefixUrl = evilServer.url;
							return retryWithMergedOptions(updatedOptions);
						}

						return response;
					},
				],
			},
		});

		assert.strictEqual(received.method, 'POST');
		assert.strictEqual(received.url, '/api');
		assert.strictEqual(received.authorization, undefined);
		assert.strictEqual(received.cookie, undefined);
		assert.strictEqual(received.body, '');
		assert.strictEqual(received.contentType, undefined);
	} finally {
		await trustedServer.close();
		await evilServer.close();
	}
});

test('afterResponse retryWithMergedOptions preserves explicit prefixUrl credentials when reusing request options cross-origin', async _t => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/api');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/api`);
	const nextPrefixUrl = new URL(evilServer.url);
	nextPrefixUrl.username = 'new-user';
	nextPrefixUrl.password = 'new-password';

	try {
		await got('api', {
			prefixUrl: trustedServer.url,
			username: 'old-user',
			password: 'old-password',
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => {
						const body = JSON.parse(response.body as string);
						if (body.retryUrl) {
							const updatedOptions = response.request.options;
							updatedOptions.prefixUrl = nextPrefixUrl;
							return retryWithMergedOptions(updatedOptions);
						}

						return response;
					},
				],
			},
		});

		assert.strictEqual(received.method, 'GET');
		assert.strictEqual(received.url, '/api');
		assert.strictEqual(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	} finally {
		await trustedServer.close();
		await evilServer.close();
	}
});

test('afterResponse retryWithMergedOptions preserves explicit headers on cross-origin retry', async _t => {
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

	assert.strictEqual(evilReceivedAuth, 'Bearer NEW');
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions removes explicit undefined headers on cross-origin retry', async _t => {
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

	assert.strictEqual(evilReceivedAuth, undefined);
	assert.strictEqual(evilReceivedCookie, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips sensitive headers and body after in-place URL mutation', async _t => {
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

	assert.strictEqual(received.authorization, undefined);
	assert.strictEqual(received.cookie, undefined);
	assert.strictEqual(received.body, '');
	assert.strictEqual(received.contentType, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions supports string url values on cross-origin retry', async _t => {
	const {server: evilServer, received} = await createCrossOriginReceiver();
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);
	await got(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					const body = JSON.parse(response.body as string);
					return body.retryUrl ? retryWithMergedOptions({url: body.retryUrl}) : response;
				},
			],
		},
	});

	assert.strictEqual(received.authorization, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions supports relative string url values', withServer, async (_t, server, got) => {
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
					return body.retry ? retryWithMergedOptions({url: '../retry'}) : response;
				},
			],
		},
	});

	assert.strictEqual(response.body, 'ok');
	assert.strictEqual(requestCount, 1);
});

test('afterResponse retryWithMergedOptions can explicitly omit generated authorization', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('afterResponse retryWithMergedOptions can explicitly omit generated cookieJar cookies', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('afterResponse retryWithMergedOptions clears stale generated cookie when cookieJar is removed', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('afterResponse retryWithMergedOptions ignores discarded cookie mutations when disabling cookieJar', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, '');
});

test('afterResponse retryWithMergedOptions preserves explicit cookie when disabling cookieJar', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, 'session=from-jar');
});

test('afterResponse retryWithMergedOptions supports query-only string url values', withServer, async (_t, server, got) => {
	server.get('/api', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?', 2)[1]);
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
					return body.retry ? retryWithMergedOptions({url: '?page=2'}) : response;
				},
			],
		},
	});

	assert.strictEqual(response.body, 'ok');
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with relative string url values', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with query-only string url values', withServer, async (_t, server, got) => {
	server.get('/api', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?', 2)[1]);
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

	assert.strictEqual(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with path-relative string url values', withServer, async (_t, server, got) => {
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

	assert.strictEqual(response.body, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
});

test('afterResponse retryWithMergedOptions resolves parent-relative string url values with query params', withServer, async (_t, server, got) => {
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
					return body.retry ? retryWithMergedOptions({url: '../target?page=2'}) : response;
				},
			],
		},
	});

	assert.strictEqual(response.body, '/nested/target?page=2');
});

test('afterResponse retryWithMergedOptions supports scheme-relative string url values', withServer, async (_t, server, got) => {
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
					return body.retry ? retryWithMergedOptions({url: `//localhost:${server.port}/scheme-relative`}) : response;
				},
			],
		},
	});

	assert.strictEqual(response.body, 'ok');
});

test('afterResponse retryWithMergedOptions preserves explicit credentials with string url values on cross-origin retry', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	assert.strictEqual(received.cookie, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions drops body on cross-origin retry', async _t => {
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

	assert.strictEqual(evilReceivedBody, '');
	assert.strictEqual(evilReceivedContentLength, '0');
	assert.strictEqual(evilReceivedContentType, undefined);
	assert.strictEqual(evilReceivedTransferEncoding, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions drops reused async iterable body on cross-origin retry', async _t => {
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

	assert.strictEqual(evilReceivedBody, '');
	assert.strictEqual(evilReceivedContentType, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit replacement URL credentials when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves body on same-origin retry', withServer, async (_t, server, got) => {
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

	assert.strictEqual(JSON.parse(response.body).secret, 'payload');
	assert.strictEqual(requestNumber, 2);
});

test('afterResponse retryWithMergedOptions preserves explicit replacement body on cross-origin retry', async _t => {
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

	assert.strictEqual(JSON.parse(received.body).secret, 'new-payload');
	assert.strictEqual(received.contentType, 'application/json');
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit URL object credentials on cross-origin retry', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit URL object username on cross-origin retry', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips inherited password when explicit URL object keeps only username', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves same-value credentials on replacement url', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit replacement body when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.body, 'new-payload');
	assert.strictEqual(received.contentType, 'text/plain');
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips sensitive headers after headers object reassignment on cross-origin retry', async _t => {
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

	assert.strictEqual(received.authorization, undefined);
	assert.strictEqual(received.cookie, undefined);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves in-place body rewrite when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.body, 'new-payload');
	assert.strictEqual(received.contentType, 'text/plain');
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves same-value authorization and body when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.authorization, 'Bearer secret');
	assert.strictEqual(received.body, 'payload');
	assert.strictEqual(received.contentType, 'text/plain');
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves explicit replacement credentials when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves same-value credentials when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions preserves URL object credentials when reusing request options cross-origin', async _t => {
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

	assert.strictEqual(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);
	await trustedServer.close();
	await evilServer.close();
});

test('afterResponse retryWithMergedOptions strips inherited url credentials after in-place cross-origin url mutation', async _t => {
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

	assert.strictEqual(received.authorization, undefined);
	await trustedServer.close();
	await evilServer.close();
});

for (const searchParameters of [{page: 2}, 'page=2', new URLSearchParams({page: '2'})]) {
	test(`afterResponse retry applies ${typeof searchParameters === 'string' ? 'string' : searchParameters.constructor.name} search parameters to the new URL`, withServer, async (_t, server, got) => {
		server.get('/first', (_request, response) => {
			response.end('first');
		});
		server.get('/next', (request, response) => {
			response.end(request.url);
		});

		const response = await got('first', {
			hooks: {
				afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: new URL('/next?old=value', server.url),
					searchParams: searchParameters,
				})],
			},
		});

		assert.strictEqual(response.body, '/next?page=2');
	});
}

for (const [searchParameters, expectedQuery] of [[undefined, '?old=value'], ['', ''], [{}, ''], [new URLSearchParams([['page', '2'], ['page', '3']]), '?page=2&page=3']] as const) {
	test(`afterResponse retry handles query override ${JSON.stringify(searchParameters)} producing ${expectedQuery}`, withServer, async (_t, server, got) => {
		server.get('/first', (_request, response) => {
			response.end('first');
		});
		server.get('/next', (request, response) => {
			response.end(request.url);
		});

		const response = await got('first', {
			hooks: {
				afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: new URL('/next?old=value', server.url),
					searchParams: searchParameters,
				})],
			},
		});

		assert.strictEqual(response.body, `/next${expectedQuery}`);
	});
}

test('afterResponse retry with a generator body strips sensitive headers on cross-origin retry', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const target = await createHttpTestServer({bodyParser: false});
	let receivedAuth: string | undefined;
	let receivedCookie: string | undefined;
	let receivedBody = '';
	target.post('/', async (request, response) => {
		receivedAuth = request.headers.authorization;
		receivedCookie = request.headers.cookie;
		receivedBody = await getStream(request);
		response.end('done');
	});

	const source = await createHttpTestServer();
	let sourceAuth: string | undefined;
	let sourceCookie: string | undefined;
	source.post('/', (request, response) => {
		sourceAuth = request.headers.authorization;
		sourceCookie = request.headers.cookie;
		response.end('retry me');
	});

	t.after(async () => {
		await Promise.all([target.close(), source.close()]);
	});

	const response = await got(source.url, {
		method: 'POST',
		body: 'original',
		headers: {authorization: 'Bearer SECRET', cookie: 'session=s3cr3t'},
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: new URL(target.url),
					body: (async function * () {
						yield 'cross-origin';
					})(),
				}),
			],
		},
	});

	// The first request carried the credentials, so their absence on the target is a real strip.
	assert.strictEqual(sourceAuth, 'Bearer SECRET');
	assert.strictEqual(sourceCookie, 'session=s3cr3t');
	assert.strictEqual(response.body, 'done');
	assert.strictEqual(receivedBody, 'cross-origin');
	assert.strictEqual(receivedAuth, undefined);
	assert.strictEqual(receivedCookie, undefined);
});

test('afterResponse retry with a generator body keeps an explicit content type', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const server = await createHttpTestServer({bodyParser: false});
	const received: Array<{body: string; contentType: string | undefined}> = [];
	server.post('/', async (request, response) => {
		received.push({body: await getStream(request), contentType: request.headers['content-type']});
		response.end('done');
	});

	t.after(async () => {
		await server.close();
	});
	await got(server.url, {
		method: 'POST',
		body: 'original',
		headers: {'content-type': 'application/json'},
		retry: {limit: 0},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({
					body: (async function * () {
						yield '{"replaced":true}';
					})(),
				}),
			],
		},
	});

	assert.strictEqual(received[1]!.body, '{"replaced":true}');
	assert.strictEqual(received[1]!.contentType, 'application/json');
});

// `structuredClone` returns a plain `Uint8Array` for a `Buffer`, so a byte-identical
// body must still count as unchanged when a hook changes the origin.
for (const [name, body] of [
	['Buffer', Buffer.from('stream-secret')],
	['Uint8Array', new TextEncoder().encode('stream-secret')],
	['DataView', new DataView(new TextEncoder().encode('stream-secret').buffer)],
] as Array<[string, ArrayBufferView]>) {
	test(`beforeRequest origin change drops an unchanged ${name} body`, withServer, async (_t, server, got) => {
		const {server: evilServer, received} = await createCrossOriginReceiver('/items', 'success');

		try {
			const {body: responseBody} = await got.post('items', {
				prefixUrl: server.url,
				body,
				hooks: {
					beforeRequest: [
						options => {
							options.prefixUrl = evilServer.url;
						},
					],
				},
			});

			assert.strictEqual(responseBody, 'success');
			assert.strictEqual(received.method, 'POST');
			assert.strictEqual(received.body, '');
		} finally {
			await evilServer.close();
		}
	});
}

test('afterResponse cross-origin retry drops an unchanged Buffer body', withServer, async _t => {
	const {server: evilServer, received} = await createCrossOriginReceiver('/steal', 'stolen');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/steal`);

	try {
		await got.post(trustedServer.url + '/api', {
			body: Buffer.from('payload'),
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => JSON.parse(response.body as string).retryUrl ? retryWithMergedOptions({url: new URL(`${evilServer.url}/steal`)}) : response,
				],
			},
		});

		assert.strictEqual(received.body, '');
		assert.strictEqual(received.contentType, undefined);
	} finally {
		await evilServer.close();
		await trustedServer.close();
	}
});

// A `beforeRequest` hook that replaces the body must refresh the inherited `content-length`.
// The retry and redirect hooks already do; without it here the declared length belongs to the
// previous body and the extra bytes stay on the connection.
for (const [name, replaceWith] of [
	['a longer string', 'a-much-longer-replacement-body'],
	['an empty string', ''],
	['no body', undefined],
	['a Buffer', Buffer.from('a buffer body')],
] as Array<[string, string | Uint8Array | undefined]>) {
	test(`a beforeRequest hook that replaces the body with ${name} refreshes the content length`, withServer, async (_t, server, got) => {
		let received = '';
		let declared: string | undefined;
		server.post('/', (request, response) => {
			declared = request.headers['content-length'];
			received = '';
			request.on('data', chunk => {
				received += chunk as string;
			});
			request.on('end', () => {
				response.end('ok');
			});
		});
		await got.post('', {
			body: 'original',
			retry: {
				limit: 0,
			},
			hooks: {
				beforeRequest: [(options: NormalizedOptions) => {
					options.body = replaceWith as string;
				}],
			},
		});

		assert.strictEqual(received, replaceWith === undefined ? '' : String(replaceWith));
		assert.strictEqual(declared, replaceWith === undefined ? '0' : String(Buffer.byteLength(String(replaceWith))));
	});
}

test('a beforeRequest hook keeps an explicit content length for the body it sets', withServer, async (_t, server, got) => {
	const body = 'the body the hook declares';
	let received = '';
	let declared: string | undefined;
	server.post('/', (request, response) => {
		declared = request.headers['content-length'];
		received = '';
		request.on('data', chunk => {
			received += chunk as string;
		});
		request.on('end', () => {
			response.end('ok');
		});
	});
	await got.post('', {
		body: 'original',
		retry: {
			limit: 0,
		},
		hooks: {
			beforeRequest: [(options: NormalizedOptions) => {
				options.body = body;
				options.headers['content-length'] = String(body.length);
			}],
		},
	});

	assert.strictEqual(received, body);
	assert.strictEqual(declared, String(body.length));
});

// A hook that switches to a method with no body slot has to drop or replace the body, the same
// way the initial request preparation requires.
test('a beforeRequest hook that switches to GET without a body is rejected', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.end('ok');
	});
	await assert.rejects(got.post('', {
		body: 'payload',
		retry: {
			limit: 0,
		},
		hooks: {
			beforeRequest: [(options: NormalizedOptions) => {
				options.method = 'GET';
			}],
		},
	}), {message: 'The `GET` method cannot be used with a body'});
});

test('a beforeRedirect hook that switches to GET without a body is rejected', withServer, async (_t, server, got) => {
	server.post('/start', (_request, response) => {
		response.writeHead(307, {location: '/final'});
		response.end();
	});
	server.post('/final', (_request, response) => {
		response.end('ok');
	});
	await assert.rejects(got.post('start', {
		body: 'payload',
		retry: {
			limit: 0,
		},
		hooks: {
			beforeRedirect: [(options: NormalizedOptions) => {
				options.method = 'GET';
			}],
		},
	}), {message: 'The `GET` method cannot be used with a body'});
});

// A `FormData` body is only serialized while the request is prepared, and a hook can install
// one after that, so it has to be serialized again once the hooks have run.
for (const [name, hookName] of [
	['beforeRequest', 'beforeRequest'],
	['beforeRedirect', 'beforeRedirect'],
] as Array<[string, 'beforeRequest' | 'beforeRedirect']>) {
	test(`a ${name} hook can assign a FormData body`, withServer, async (_t, server, got) => {
		const form = new FormData();
		form.set('field', 'value');

		let contentType: string | undefined;
		let body = '';
		server.post('/start', (_request, response) => {
			response.writeHead(307, {location: '/final'});
			response.end();
		});
		server.post('/final', (request, response) => {
			contentType = request.headers['content-type'];
			request.on('data', chunk => {
				body += chunk as string;
			});
			request.on('end', () => {
				response.end('ok');
			});
		});
		await got.post('start', {
			method: 'POST',
			body: 'original',
			retry: {
				limit: 0,
			},
			hooks: {
				[hookName]: [(options: NormalizedOptions) => {
					options.body = form;
				}],
			},
		});

		assert.strictEqual(contentType?.startsWith('multipart/form-data; boundary=') ?? false, true);
		assert.strictEqual(body.includes('name="field"'), true);
		assert.strictEqual(body.includes('value'), true);
	});
}

// Every serialization picks a new boundary, so replacing one `FormData` with another must
// refresh the header too, or the parts are never found.
test('a hook that replaces a FormData body refreshes the generated boundary', withServer, async (_t, server, got) => {
	const original = new FormData();
	original.set('field', 'original');
	const replacement = new FormData();
	replacement.set('field', 'replacement');

	let contentType: string | undefined;
	let body = '';
	server.post('/', (request, response) => {
		contentType = request.headers['content-type'];
		request.on('data', chunk => {
			body += chunk as string;
		});
		request.on('end', () => {
			response.end('ok');
		});
	});
	await got.post('', {
		body: original,
		retry: {
			limit: 0,
		},
		hooks: {
			beforeRequest: [(options: NormalizedOptions) => {
				options.body = replacement;
			}],
		},
	});

	const boundary = /boundary=(?<boundary>[^;]+)$/v.exec(contentType ?? '')?.groups?.boundary;
	assert.ok(boundary);
	assert.strictEqual(body.includes(boundary), true, 'The boundary in the header does not appear in the body');
	assert.strictEqual(body.includes('replacement'), true);
	assert.strictEqual(body.includes('original'), false);
});
