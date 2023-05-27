import {Buffer} from 'node:buffer';
import {Agent as HttpAgent} from 'node:http';
import test from 'ava';
import nock from 'nock';
import getStream from 'get-stream';
import FormData from 'form-data';
import sinon from 'sinon';
import delay from 'delay';
import type {Handler} from 'express';
import Responselike from 'responselike';
import type {Constructor} from 'type-fest';
import got, {RequestError, HTTPError, type Response, type OptionsInit} from '../source/index.js';
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

const createAgentSpy = <T extends HttpAgent>(AgentClass: Constructor<any>): {agent: T; spy: sinon.SinonSpy} => {
	const agent: T = new AgentClass({keepAlive: true});
	// eslint-disable-next-line import/no-named-as-default-member
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

test('passes init thrown errors to beforeError hooks (promise-only)', async t => {
	t.plan(1);

	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}],
			beforeError: [error => {
				t.is(error.message, errorString);

				return error;
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

test('accepts an async function as init hook', async t => {
	await got('https://example.com', {
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
					const url = options.url as URL;
					t.is(url.pathname, '/');
					t.is(url.hostname, 'localhost');
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

test('beforeRedirect is called with options and response', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	await got('redirect', {
		responseType: 'json',
		hooks: {
			beforeRedirect: [
				(options, response) => {
					const url = options.url as URL;
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
		const form = new FormData();
		form.append('A', 'B');
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
					const form = generateBody();
					options.body = form;
					options.headers['content-type'] = `multipart/form-data; boundary=${form.getBoundary()}`;
					options.headers.foo = 'bar';
				},
			],
		},
	});

	t.is(body, 'test');
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

	const {statusCode} = await got({
		url: server.url,
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

test('cancelling the request after retrying in a afterResponse hook', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end();
	});

	const gotPromise = got({
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => {
					const promise = retryWithMergedOptions({
						headers: {
							token: 'unicorn',
						},
					});

					gotPromise.cancel();

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
	}), {instanceOf: HTTPError, message: 'Response code 401 (Unauthorized)'});
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
	}), {instanceOf: HTTPError, message: 'Response code 500 (Internal Server Error)'});
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

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [
				() => {
					throw error;
				},
			],
			beforeError: [error2 => {
				t.true(error2 instanceof Error);
				return error2;
			}],
		},
	}), {message: errorString});
});

test('beforeError is called with an error - stream', withServer, async (t, _server, got) => {
	await t.throwsAsync(getStream(got.stream({
		hooks: {
			beforeError: [error2 => {
				t.true(error2 instanceof Error);
				return error2;
			}],
		},
	})), {message: 'Response code 404 (Not Found)'});
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
	t.plan(2);

	await t.throwsAsync(got({
		hooks: {
			beforeError: [
				error => {
					t.true(error instanceof HTTPError);
					return error;
				},
			],
		},
	}));
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

test('beforeError emits valid promise `HTTPError`s', async t => {
	t.plan(3);

	nock('https://ValidHTTPErrors.com').get('/').reply(() => [422, 'no']);

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

	await t.throwsAsync(instance('https://ValidHTTPErrors.com'));
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
	}), {message: 'Response code 404 (Not Found)'});

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

	const {agent, spy} = createAgentSpy(HttpAgent);

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
	t.true(spy.calledOnce);

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
					options.headers['content-length'] = options.body.length.toString();
				},
			],
		},
	});

	t.is(JSON.parse(response.body).payload, 'new');
});

test('can retry without an agent', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 408;
		response.end();
	});

	let counter = 0;

	class MyAgent extends HttpAgent {
		createConnection(port: any, options: any, callback: any) {
			counter++;

			return (HttpAgent as any).prototype.createConnection.call(this, port, options, callback);
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
	})))!;

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
