import {PassThrough} from 'node:stream';
import test from 'ava';
import delay from 'delay';
import {pEvent} from 'p-event';
import {AbortError, TimeoutError, type RequestError} from '../source/index.js';
import withServer from './helpers/with-server.js';

const errorMatcher = {
	instanceOf: TimeoutError,
	code: 'ETIMEDOUT',
};

const noRetry = {limit: 0};

test('the budget covers a slow final response after a fast redirect', withServer, async (t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', async (_request, response) => {
		finalRequests++;
		await delay(400);
		response.end('late');
	});

	const error = await t.throwsAsync<TimeoutError>(got('redirect', {timeout: {request: 200}, retry: noRetry}), errorMatcher);

	t.is(error.event, 'request');
	t.is(finalRequests, 1);
});

test('a redirect that arrives after the budget expired is not followed', withServer, async (t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', async (_request, response) => {
		await delay(400);
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('final');
	});

	await t.throwsAsync(got('redirect', {timeout: {request: 200}, retry: noRetry}), errorMatcher);
	await delay(300);

	t.is(finalRequests, 0);
});

test('a redirect chain fails on the hop that exhausts the budget', withServer, async (t, server, got) => {
	const visited: string[] = [];
	for (const hop of [1, 2, 3]) {
		server.get(`/${hop}`, async (request, response) => {
			visited.push(request.path);
			await delay(100);
			response.writeHead(302, {location: `/${hop + 1}`}).end();
		});
	}

	server.get('/4', (request, response) => {
		visited.push(request.path);
		response.end('final');
	});

	const error = await t.throwsAsync<TimeoutError>(got('1', {timeout: {request: 250}, retry: noRetry}), errorMatcher);

	t.is(error.event, 'request');
	t.is(error.message, 'Timeout awaiting \'request\' for 250ms');
	t.deepEqual(visited, ['/1', '/2', '/3']);
});

test('the budget covers a stalled response body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-type': 'text/plain'});
		response.write('partial');
	});

	const error = await t.throwsAsync<TimeoutError>(got('', {timeout: {request: 200}, retry: noRetry}), errorMatcher);

	t.is(error.event, 'request');
});

test('the budget covers a stalled upload', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		request.on('end', () => {
			response.end('done');
		});
		request.resume();
	});

	const body = new PassThrough();
	body.write('never finishes');

	const error = await t.throwsAsync<TimeoutError>(got.post('', {body, timeout: {request: 200}, retry: noRetry}), errorMatcher);

	t.is(error.event, 'request');
	t.true(body.destroyed);
});

test('a zero budget fails before sending the request', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end('ok');
	});

	const error = await t.throwsAsync<TimeoutError>(got('', {timeout: {request: 0}, retry: noRetry}), errorMatcher);
	await delay(50);

	t.is(error.event, 'request');
	t.is(requests, 0);
});

test('the request timeout does not count beforeRequest hooks of the first request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got('', {
		timeout: {request: 100},
		retry: noRetry,
		hooks: {
			beforeRequest: [async () => {
				await delay(200);
			}],
		},
	});

	t.is(body, 'ok');
});

test('a beforeRedirect hook can disable the request timeout for the redirected request', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', async (_request, response) => {
		await delay(250);
		response.end('slow but fine');
	});

	const {body} = await got('redirect', {
		timeout: {request: 100},
		retry: noRetry,
		hooks: {
			beforeRedirect: [options => {
				options.timeout.request = undefined;
			}],
		},
	});

	t.is(body, 'slow but fine');
});

test('a redirected beforeRequest hook can lower the request timeout', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', async (_request, response) => {
		await delay(400);
		response.end('late');
	});

	const startedAt = Date.now();
	const error = await t.throwsAsync<TimeoutError>(got('redirect', {
		timeout: {request: 2000},
		retry: noRetry,
		hooks: {
			beforeRequest: [options => {
				if (options.url instanceof URL && options.url.pathname === '/final') {
					options.timeout.request = 100;
				}
			}],
		},
	}), errorMatcher);

	t.is(error.event, 'request');
	t.true(Date.now() - startedAt < 1000);
});

test('each retry gets a fresh request budget', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', async (_request, response) => {
		requests++;

		if (requests === 1) {
			await delay(400);
		}

		response.end('ok');
	});

	const response = await got('', {
		timeout: {request: 200},
		retry: {
			limit: 1,
			calculateDelay: () => 1,
		},
	});

	t.is(response.body, 'ok');
	t.is(response.retryCount, 1);
	t.is(requests, 2);
});

test('a manual retry from afterResponse gets a fresh request budget', withServer, async (t, server, got) => {
	let requests = 0;
	server.get('/', async (_request, response) => {
		requests++;
		await delay(150);
		response.end(requests === 1 ? 'retry' : 'ok');
	});

	const response = await got('', {
		timeout: {request: 250},
		retry: noRetry,
		hooks: {
			afterResponse: [(response, retryWithMergedOptions) => {
				if (response.body === 'retry') {
					return retryWithMergedOptions({});
				}

				return response;
			}],
		},
	});

	t.is(response.body, 'ok');
	t.is(requests, 2);
});

test('each pagination page gets a fresh request budget', withServer, async (t, server, got) => {
	server.get('/', async (_request, response) => {
		await delay(150);
		response.setHeader('link', '</next>; rel="next"');
		response.end('[1]');
	});
	server.get('/next', async (_request, response) => {
		await delay(150);
		response.end('[2]');
	});

	t.deepEqual(await got.paginate.all<number>('', {timeout: {request: 250}, retry: noRetry}), [1, 2]);
});

test('the stream API reports the request timeout with the request event', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', () => {});

	const stream = got.stream('redirect', {timeout: {request: 200}, retry: noRetry});
	stream.resume();
	const error = await pEvent<'error', TimeoutError>(stream, 'error');

	t.true(error instanceof TimeoutError);
	t.is(error.event, 'request');
	t.is(error.code, 'ETIMEDOUT');
});

test('the request timeout is cleared after the response ends', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const stream = got.stream('', {timeout: {request: 100}, retry: noRetry});
	const errors: Error[] = [];
	stream.on('error', error => {
		errors.push(error);
	});
	stream.resume();
	await pEvent(stream, 'end');
	await delay(200);

	t.deepEqual(errors, []);
});

test('the request timeout is cleared when the request is aborted', withServer, async (t, server, got) => {
	server.get('/', () => {});

	const controller = new AbortController();
	const stream = got.stream('', {timeout: {request: 100}, retry: noRetry, signal: controller.signal});
	const errors: Error[] = [];
	stream.on('error', error => {
		errors.push(error);
	});
	stream.resume();
	controller.abort();
	await delay(200);

	t.is(errors.length, 1);
	t.true(errors[0] instanceof AbortError);
});

test('the request timeout and the response timeout report whichever expires first', withServer, async (t, server, got) => {
	server.get('/', () => {});

	const responseFirst = await t.throwsAsync<TimeoutError>(got('', {timeout: {request: 1000, response: 50}, retry: noRetry}), errorMatcher);
	const requestFirst = await t.throwsAsync<TimeoutError>(got('', {timeout: {request: 50, response: 1000}, retry: noRetry}), errorMatcher);

	t.is(responseFirst.event, 'response');
	t.is(requestFirst.event, 'request');
});

test('beforeError hooks receive the request timeout error with timings', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', () => {});

	let hookError: RequestError | undefined;
	const error = await t.throwsAsync<TimeoutError>(got('redirect', {
		timeout: {request: 200},
		retry: noRetry,
		hooks: {
			beforeError: [error => {
				hookError = error;
				return error;
			}],
		},
	}), errorMatcher);

	t.is(hookError, error);
	t.is(error.event, 'request');
	t.is(typeof error.timings.phases.total, 'number');
});

test('a request timeout during a beforeRedirect hook keeps the error timings', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});

	let finalRequests = 0;
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('final');
	});

	const error = await t.throwsAsync<TimeoutError>(got('redirect', {
		timeout: {request: 100},
		retry: noRetry,
		hooks: {
			beforeRedirect: [async () => {
				await delay(300);
			}],
		},
	}), errorMatcher);
	await delay(300);

	t.is(error.event, 'request');
	t.is(typeof error.timings.phases.total, 'number');
	t.is(finalRequests, 0);
});
