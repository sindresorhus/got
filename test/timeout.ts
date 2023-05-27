import process from 'node:process';
import {EventEmitter} from 'node:events';
import stream, {PassThrough as PassThroughStream} from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import http from 'node:http';
import net from 'node:net';
import getStream from 'get-stream';
import test from 'ava';
import delay from 'delay';
import type CacheableLookup from 'cacheable-lookup';
import type {Handler} from 'express';
import {pEvent} from 'p-event';
import got, {type RequestError, TimeoutError} from '../source/index.js';
import timedOut from '../source/core/timed-out.js';
import slowDataStream from './helpers/slow-data-stream.js';
import type {GlobalClock} from './helpers/types.js';
import withServer, {withServerAndFakeTimers, withHttpsServer} from './helpers/with-server.js';

const requestDelay = 800;

const errorMatcher = {
	instanceOf: TimeoutError,
	code: 'ETIMEDOUT',
};

const keepAliveAgent = new http.Agent({
	keepAlive: true,
});

const defaultHandler = (clock: GlobalClock): Handler => (request, response) => {
	request.resume();
	request.on('end', () => {
		clock.tick(requestDelay);
		response.end('OK');
	});
};

const downloadHandler = (clock?: GlobalClock): Handler => (_request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked',
	});
	response.flushHeaders();

	setImmediate(async () => {
		await streamPipeline(slowDataStream(clock), response);
	});
};

test.serial('timeout option', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {
				request: 1,
			},
			retry: {
				limit: 0,
			},
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms',
		},
	);
});

test.serial('timeout option as object', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {request: 1},
			retry: {
				limit: 0,
			},
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms',
		},
	);
});

test.serial('socket timeout', async t => {
	await t.throwsAsync(
		got('https://example.com', {
			timeout: {socket: 1},
			retry: {
				limit: 0,
			},
			request() {
				const stream = new PassThroughStream();
				// @ts-expect-error Mocking the behaviour of a ClientRequest
				stream.setTimeout = (ms, callback) => {
					process.nextTick(callback);
				};

				// @ts-expect-error Mocking the behaviour of a ClientRequest
				stream.abort = () => {};
				stream.resume();

				return stream as unknown as http.ClientRequest;
			},
		}),
		{
			instanceOf: TimeoutError,
			code: 'ETIMEDOUT',
			message: 'Timeout awaiting \'socket\' for 1ms',
		},
	);
});

test.serial('send timeout', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.post('/', defaultHandler(clock));

	await t.throwsAsync(
		got.post({
			timeout: {send: 1},
			body: new stream.PassThrough(),
			retry: {
				limit: 0,
			},
		}).on('request', request => {
			request.once('socket', socket => {
				socket.once('connect', () => {
					clock.tick(10);
				});
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms',
		},
	);
});

test.serial('send timeout (keepalive)', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.post('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});

	await t.throwsAsync(
		got.post({
			agent: {
				http: keepAliveAgent,
			},
			timeout: {send: 1},
			retry: {
				limit: 0,
			},
			body: slowDataStream(clock),
		}).on('request', (request: http.ClientRequest) => {
			request.once('socket', socket => {
				t.false(socket.connecting);

				socket.once('connect', () => {
					t.fail('\'connect\' event fired, invalidating test');
				});
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms',
		},
	);
});

test.serial('response timeout', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {response: 1},
			retry: {
				limit: 0,
			},
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'response\' for 1ms',
		},
	);
});

test.serial('response timeout unaffected by slow upload', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.post('/', defaultHandler(clock));

	await t.notThrowsAsync(got.post({
		retry: {
			limit: 0,
		},
		body: slowDataStream(clock),
	}));
});

test.serial('response timeout unaffected by slow download', withServer, async (t, server, got) => {
	server.get('/', downloadHandler());

	await t.notThrowsAsync(got({
		timeout: {response: 200},
		retry: {
			limit: 0,
		},
	}));

	await delay(100);
});

test.serial('response timeout (keepalive)', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});

	const request = got({
		agent: {
			http: keepAliveAgent,
		},
		timeout: {response: 1},
		retry: {
			limit: 0,
		},
	}).on('request', (request: http.ClientRequest) => {
		request.once('socket', socket => {
			t.false(socket.connecting);
			socket.once('connect', () => {
				t.fail('\'connect\' event fired, invalidating test');
			});
		});
	});

	await t.throwsAsync(request, {
		...errorMatcher,
		message: 'Timeout awaiting \'response\' for 1ms',
	});
});

test.serial('connect timeout', withServerAndFakeTimers, async (t, _server, got, clock) => {
	await t.throwsAsync(
		got({
			createConnection(options) {
				const socket = new net.Socket(options as Record<string, unknown> as net.SocketConstructorOpts);
				// @ts-expect-error We know that it is readonly, but we have to test it
				socket.connecting = true;
				setImmediate(() => {
					socket.emit('lookup', null, '127.0.0.1', 4, 'localhost');
				});
				return socket;
			},
			timeout: {connect: 1},
			retry: {
				limit: 0,
			},
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms',
		},
	);
});

test.serial('connect timeout (ip address)', withServerAndFakeTimers, async (t, _server, _got, clock) => {
	await t.throwsAsync(
		got({
			url: 'http://127.0.0.1',
			createConnection(options) {
				const socket = new net.Socket(options as Record<string, unknown> as net.SocketConstructorOpts);
				// @ts-expect-error We know that it is readonly, but we have to test it
				socket.connecting = true;
				return socket;
			},
			timeout: {connect: 1},
			retry: {
				limit: 0,
			},
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms',
		},
	);
});

test.serial('secureConnect timeout', withHttpsServer({}, true), async (t, _server, got, clock) => {
	await t.throwsAsync(
		got({
			createConnection(options) {
				const socket = new net.Socket(options as Record<string, unknown> as net.SocketConstructorOpts);
				// @ts-expect-error We know that it is readonly, but we have to test it
				socket.connecting = true;
				setImmediate(() => {
					socket.emit('lookup', null, '127.0.0.1', 4, 'localhost');

					setImmediate(() => {
						socket.emit('connect');
					});
				});
				return socket;
			},
			timeout: {secureConnect: 0},
			retry: {
				limit: 0,
			},
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'secureConnect\' for 0ms',
		},
	);
});

test('secureConnect timeout not breached', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.notThrowsAsync(got({
		timeout: {secureConnect: 200},
		retry: {
			limit: 0,
		},
		https: {
			rejectUnauthorized: false,
		},
	}));
});

test.serial('lookup timeout', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			dnsLookup() {},
			timeout: {lookup: 1},
			retry: {
				limit: 0,
			},
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'lookup\' for 1ms',
		},
	);
});

test.serial('lookup timeout no error (ip address)', withServerAndFakeTimers, async (t, server, _got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.notThrowsAsync(got({
		url: `http://127.0.0.1:${server.port}`,
		timeout: {lookup: 1},
		retry: {limit: 0},
	}));
});

test.serial('lookup timeout no error (keepalive)', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});
	await t.notThrowsAsync(got({
		agent: {http: keepAliveAgent},
		timeout: {lookup: 1},
		retry: {limit: 0},
	}).on('request', (request: http.ClientRequest) => {
		request.once('connect', () => {
			t.fail('connect event fired, invalidating test');
		});
	}));

	keepAliveAgent.destroy();
});

test.serial('retries on timeout', withServer, async (t, server, got) => {
	server.get('/', () => {});

	let hasTried = false;
	await t.throwsAsync(got({
		timeout: {
			request: 1,
		},
		retry: {
			calculateDelay() {
				if (hasTried) {
					return 0;
				}

				hasTried = true;
				return 1;
			},
		},
	}), {
		...errorMatcher,
		message: 'Timeout awaiting \'request\' for 1ms',
	});

	t.true(hasTried);
});

test.serial('timeout with streams', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const stream = got.stream({
		timeout: {request: 0},
		retry: {limit: 0},
	});
	await t.throwsAsync(pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});

test.serial('no error emitted when timeout is not breached (stream)', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const stream = got.stream({
		retry: {
			limit: 0,
		},
		timeout: {
			request: requestDelay * 2,
		},
	});

	await t.notThrowsAsync(getStream(stream));
});

test.serial('no error emitted when timeout is not breached (promise)', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.notThrowsAsync(got({
		retry: {
			limit: 0,
		},
		timeout: {
			request: requestDelay * 2,
		},
	}));
});

test.serial('no unhandled `socket hung up` errors', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			retry: {
				limit: 0,
			},
			timeout: {
				request: requestDelay / 2,
			},
		}),
		{instanceOf: TimeoutError},
	);
});

// TODO: use fakeTimers here
test.serial('no unhandled timeout errors', withServer, async (t, _server, got) => {
	await t.throwsAsync(got({
		retry: {limit: 0},
		timeout: {request: 100},
		request(...args) {
			const result = http.request(...args);

			result.once('socket', () => {
				result.socket?.destroy();
			});

			return result;
		},
	}), {message: 'socket hang up'});

	await delay(200);
});

// TODO: use fakeTimers here
test.serial('no unhandled timeout errors #2', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('Hello world!');
	});

	const gotPromise = got('', {
		timeout: {
			request: 20,
		},
		retry: {
			calculateDelay({computedValue}) {
				if (computedValue) {
					return 10;
				}

				return 0;
			},
			limit: 1,
		},
	});

	await t.throwsAsync(gotPromise, {instanceOf: TimeoutError});

	await delay(100);
});

test.serial('no more timeouts after an error', withServer, async (t, _server, got) => {
	const {setTimeout} = global;
	const {clearTimeout} = global;

	// @ts-expect-error FIXME
	global.setTimeout = (callback, _ms, ...args) => {
		const timeout = {
			isCleared: false,
		};

		process.nextTick(() => {
			if (timeout.isCleared) {
				return;
			}

			callback(...args);
		});

		return timeout;
	};

	global.clearTimeout = timeout => {
		if (timeout) {
			// @ts-expect-error FIXME
			timeout.isCleared = true;
		}
	};

	await t.throwsAsync(got(`http://${Date.now()}.dev`, {
		retry: {limit: 1},
		timeout: {
			lookup: 1,
			connect: 1,
			secureConnect: 1,
			socket: 1,
			response: 1,
			send: 1,
			request: 1,
		},
	}), {instanceOf: TimeoutError});

	await delay(100);

	global.setTimeout = setTimeout;
	global.clearTimeout = clearTimeout;
});

test.serial('socket timeout is canceled on error', withServerAndFakeTimers, async (t, _server, got, clock) => {
	const message = 'oh, snap!';

	const promise = got({
		timeout: {socket: 50},
		retry: {limit: 0},
	}).on('request', (request: http.ClientRequest) => {
		request.destroy(new Error(message));
	});

	await t.throwsAsync(promise, {message});

	// Wait a bit more to check if there are any unhandled errors
	clock.tick(100);
});

test.serial('no memory leak when using socket timeout and keepalive agent', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	let request: any;

	await got({
		agent: {http: keepAliveAgent},
		timeout: {socket: requestDelay * 2},
	}).on('request', _request => {
		request = _request;
	});

	t.is(request.timeoutCb, null);

	keepAliveAgent.destroy();
});

test('ensure there are no new timeouts after cancelation', t => {
	const emitter = new EventEmitter();
	const socket = new EventEmitter();
	(socket as any).connecting = true;

	timedOut(emitter as http.ClientRequest, {
		connect: 1,
	}, {
		hostname: '127.0.0.1',
	})();

	emitter.emit('socket', socket);
	socket.emit('lookup', null);
	t.is(socket.listenerCount('connect'), 0);
});

test('double calling timedOut has no effect', t => {
	const emitter = new EventEmitter();

	const attach = (): () => void => timedOut(emitter as http.ClientRequest, {
		connect: 1,
	}, {
		hostname: '127.0.0.1',
	});

	attach();
	attach();

	t.is(emitter.listenerCount('socket'), 1);
});

test.serial('doesn\'t throw on early lookup', withServerAndFakeTimers, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.notThrowsAsync(got('', {
		timeout: {
			lookup: 1,
		},
		retry: {limit: 0},
		// @ts-expect-error FIXME
		dnsLookup(...[_hostname, options, callback]: Parameters<CacheableLookup['lookup']>) {
			if (typeof options === 'function') {
				callback = options;
			}

			callback(null, '127.0.0.1', 4);
		},
	}));
});

// TODO: use fakeTimers here
test.serial('no unhandled `Premature close` error', withServer, async (t, server, got) => {
	server.get('/', async (_request, response) => {
		response.write('hello');
	});

	await t.throwsAsync(got({
		timeout: {request: 10},
		retry: {limit: 0},
	}), {message: 'Timeout awaiting \'request\' for 10ms'});

	await delay(20);
});

// TODO: use fakeTimers here
test.serial('`read` timeout - promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('o');
	});

	await t.throwsAsync(got({
		timeout: {
			read: 10,
		},
		retry: {
			limit: 0,
		},
	}), {message: 'Timeout awaiting \'read\' for 10ms'});
});

// TODO: use fakeTimers here
test.serial.failing('`read` timeout - stream', withServer, async (t, server, got) => {
	t.timeout(100);

	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const stream = got.stream({
		timeout: {
			read: 10,
		},
	});

	await t.throwsAsync(pEvent(stream, 'end'), {message: 'Timeout awaiting \'read\' for 10ms'});
});

// TODO: use fakeTimers here
test.serial('cancelling the request removes timeouts', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('hello');
	});

	const promise = got({
		timeout: {
			request: 500,
		},
		retry: {
			limit: 0,
		},
	}).on('downloadProgress', () => {
		promise.cancel();
	}).on('request', request => {
		request.on('error', error => {
			if (error.message === 'Timeout awaiting \'request\' for 500ms') {
				t.fail(error.message);
			}
		});
	});

	await t.throwsAsync(promise, {message: 'Promise was canceled'});

	await delay(1000);
});

test('timeouts are emitted ASAP', async t => {
	const timeout = 500;
	const marginOfError = process.env.CI ? 200 : 100;

	const error = await t.throwsAsync<TimeoutError>(got('http://192.0.2.1/test', {
		retry: {
			limit: 0,
		},
		timeout: {
			request: timeout,
		},
	}), {instanceOf: TimeoutError});

	t.true(error!.timings.phases.total! < (timeout + marginOfError));
});

test('http2 timeout', async t => {
	const error = await t.throwsAsync<RequestError>(got('https://123.123.123.123', {
		timeout: {
			request: 1,
		},
		http2: true,
		retry: {
			calculateDelay: ({computedValue}) => computedValue ? 1 : 0,
		},
	}));

	t.true(error?.code === 'ETIMEDOUT' || error?.code === 'EUNSUPPORTED', error?.stack);
});
