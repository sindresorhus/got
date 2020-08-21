import {URL} from 'url';
import {Agent as HttpAgent} from 'http';
import test, {Constructor} from 'ava';
import nock = require('nock');
import getStream = require('get-stream');
import sinon = require('sinon');
import delay = require('delay');
import {Handler} from 'express';
import Responselike = require('responselike');
import got, {RequestError, HTTPError, Response} from '../source';
import withServer from './helpers/with-server';

const errorString = 'oops';
const error = new Error(errorString);

const echoHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
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

const createAgentSpy = <T extends HttpAgent>(AgentClass: Constructor): {agent: T; spy: sinon.SinonSpy} => {
	const agent: T = new AgentClass({keepAlive: true});
	// @ts-expect-error This IS correct
	const spy = sinon.spy(agent, 'addRequest');
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
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('catches init thrown errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('passes init thrown errors to beforeError hooks (promise-only)', async t => {
	t.plan(2);

	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}],
			beforeError: [error => {
				t.is(error.message, errorString);

				return error;
			}]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('passes init thrown errors to beforeError hooks (promise-only) - beforeError rejection', async t => {
	const message = 'foo, bar!';

	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}],
			beforeError: [() => {
				throw new Error(message);
			}]
		}
	}), {message});
});

test('catches beforeRequest thrown errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			beforeRequest: [() => {
				throw error;
			}]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('catches beforeRedirect thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	await t.throwsAsync(got('redirect', {
		hooks: {
			beforeRedirect: [() => {
				throw error;
			}]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('catches beforeRetry thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	await t.throwsAsync(got('retry', {
		hooks: {
			beforeRetry: [() => {
				throw error;
			}]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('catches afterResponse thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [() => {
				throw error;
			}]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('accepts an async function as init hook', async t => {
	await got('https://example.com', {
		hooks: {
			init: [
				async () => {
					t.pass();
				}
			]
		}
	});
});

test('catches beforeRequest promise rejections', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			beforeRequest: [
				async () => {
					throw error;
				}
			]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('catches beforeRedirect promise rejections', withServer, async (t, server, got) => {
	server.get('/', redirectEndpoint);

	await t.throwsAsync(got({
		hooks: {
			beforeRedirect: [
				async () => {
					throw error;
				}
			]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('catches beforeRetry promise rejections', withServer, async (t, server, got) => {
	server.get('/retry', retryEndpoint);

	await t.throwsAsync(got('retry', {
		hooks: {
			beforeRetry: [
				async () => {
					throw error;
				}
			]
		}
	}), {
		instanceOf: RequestError,
		message: errorString
	});
});

test('catches afterResponse promise rejections', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [
				async () => {
					throw error;
				}
			]
		}
	}), {message: errorString});
});

test('catches beforeError errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new Error('No way');
		},
		hooks: {
			beforeError: [
				async () => {
					throw error;
				}
			]
		}
	}), {message: errorString});
});

test('init is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const context = {};

	await got({
		hooks: {
			init: [
				options => {
					t.is(options.context, context);
				}
			]
		},
		context
	});
});

test('init from defaults is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const context = {};

	const instance = got.extend({
		hooks: {
			init: [
				options => {
					t.is(options.context, context);
				}
			]
		}
	});

	await instance({context});
});

test('init allows modifications', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers.foo);
	});

	const {body} = await got('', {
		headers: {},
		hooks: {
			init: [
				options => {
					options.headers!.foo = 'bar';
				}
			]
		}
	});
	t.is(body, 'bar');
});

test('beforeRequest is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.url.pathname, '/');
					t.is(options.url.hostname, 'localhost');
				}
			]
		}
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
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('returning HTTP response from a beforeRequest hook', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {statusCode, headers, body} = await got({
		hooks: {
			beforeRequest: [
				() => {
					return new Responselike(
						200,
						{foo: 'bar'},
						Buffer.from('Hi!'),
						''
					);
				}
			]
		}
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
					t.is(options.url.pathname, '/');
					t.is(options.url.hostname, 'localhost');

					t.is(response.statusCode, 302);
					t.is(new URL(response.url).pathname, '/redirect');
					t.is(response.redirectUrls.length, 1);
				}
			]
		}
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
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('beforeRetry is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	const context = {};

	await got('retry', {
		responseType: 'json',
		retry: 1,
		throwHttpErrors: false,
		context,
		hooks: {
			beforeRetry: [
				(options, error, retryCount) => {
					t.is(options.url.hostname, 'localhost');
					t.is(options.context, context);
					t.truthy(error);
					t.true(retryCount! >= 1);
				}
			]
		}
	});
});

test('beforeRetry allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	const {body} = await got<Record<string, string>>('retry', {
		responseType: 'json',
		hooks: {
			beforeRetry: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(body.foo, 'bar');
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
				}
			]
		}
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
				}
			]
		}
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
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			]
		}
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
							token: 'unicorn'
						}
					});

					gotPromise.cancel();

					return promise;
				}
			]
		},
		retry: {
			calculateDelay: () => 1
		}
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
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			],
			beforeRetry: [
				options => {
					t.truthy(options);
					isCalled = true;
				}
			]
		}
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
		retry: 0,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => {
					return retryWithMergedOptions({
						headers: {
							token: 'invalid'
						}
					});
				}
			]
		}
	}), {instanceOf: got.HTTPError, message: 'Response code 401 (Unauthorized)'});
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
		retry: 1,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			]
		}
	}), {instanceOf: got.HTTPError, message: 'Response code 500 (Internal Server Error)'});
});

test('doesn\'t throw on afterResponse retry HTTP failure if throwHttpErrors is false', withServer, async (t, server, got) => {
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
		retry: 1,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			]
		}
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
				}
			],
			beforeError: [
				(): never => {
					throw new Error('foobar');
				},
				() => {
					throw new Error('This shouldn\'t be called at all');
				}
			]
		}
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
				}
			]
		}
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
				}
			],
			beforeError: [error2 => {
				t.true(error2 instanceof Error);
				return error2;
			}]
		}
	}), {message: errorString});
});

test('beforeError is called with an error - stream', withServer, async (t, _server, got) => {
	await t.throwsAsync(getStream(got.stream({
		hooks: {
			beforeError: [error2 => {
				t.true(error2 instanceof Error);
				return error2;
			}]
		}
	})), {message: 'Response code 404 (Not Found)'});
});

test('beforeError allows modifications', async t => {
	const errorString2 = 'foobar';

	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw error;
		},
		hooks: {
			beforeError: [
				error => {
					const newError = new Error(errorString2);

					return new RequestError(newError.message, newError, error.options);
				}
			]
		}
	}), {message: errorString2});
});

test('does not break on `afterResponse` hook with JSON mode', withServer, async (t, server, got) => {
	server.get('/foobar', echoHeaders);

	await t.notThrowsAsync(got('', {
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 404) {
						const url = new URL('/foobar', response.url);

						return retryWithMergedOptions({url});
					}

					return response;
				}
			]
		},
		responseType: 'json'
	}));
});

test('catches HTTPErrors', withServer, async (t, _server, got) => {
	t.plan(2);

	await t.throwsAsync(got({
		hooks: {
			beforeError: [
				error => {
					t.true(error instanceof got.HTTPError);
					return error;
				}
			]
		}
	}));
});

test('timeout can be modified using a hook', withServer, async (t, server, got) => {
	server.get('/', () => {});

	await t.throwsAsync(got({
		timeout: 1000,
		hooks: {
			beforeRequest: [
				options => {
					options.timeout.request = 500;
				}
			]
		},
		retry: 0
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
				}
			]
		}
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
				}
			]
		},
		retry: 0
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
				}
			]
		},
		retry: 0
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
				}
			]
		},
		retry: 0,
		throwHttpErrors: false
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
						http: agent
					};
				}
			]
		}
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

	t.is((await got(server.sslHostname, {
		hooks: {
			beforeRequest: [
				options => {
					options.url = new URL(server.url + '/changed');
				}
			]
		}
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
			}
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			}
		]
	};

	// Test only one request
	const instance = got.extend({
		hooks,
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	await instance.paginate.all('get');
	t.is(beforeHookCount, 1);
	t.is(afterHookCount, 1);

	await instance.paginate.all('get', {
		hooks: {
			beforeRequest: [
				() => {
					beforeHookCountAdditional++;
				}
			],
			afterResponse: [
				(response: any) => {
					afterHookCountAdditional++;
					return response;
				}
			]
		}
	});
	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	t.is(beforeHookCountAdditional, 1);
	t.is(afterHookCountAdditional, 1);

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate: () => false,
			transform: response => [response]
		}
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
			}
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			}
		]
	};

	// Test only two requests, one after another
	const paginate = () => requestNumber++ === 0 ? {} : false;

	const instance = got.extend({
		hooks,
		pagination: {
			paginate,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	await instance.paginate.all('get');

	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	requestNumber = 0;

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			transform: response => [response]
		}
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
				beforeHook
			],
			afterResponse: [
				afterHook,
				afterHook
			]
		},
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: response => [response]
		}
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
				beforeHookAdditional
			],
			afterResponse: [
				afterHook,
				afterHookAdditional,
				afterHookAdditional
			]
		}
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
			}
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			}
		]
	};

	// Test only two requests, one after another
	const paginate = (response: Response) => requestNumber++ === 0 ? response.request.options : false;

	const instance = got.extend({
		hooks,
		pagination: {
			paginate,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	await instance.paginate.all('get');

	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	requestNumber = 0;

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			transform: response => [response]
		}
	});

	t.is(beforeHookCount, 4);
	t.is(afterHookCount, 4);
});
