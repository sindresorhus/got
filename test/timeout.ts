import {promisify} from 'util';
import EventEmitter = require('events');
import {PassThrough as PassThroughStream} from 'stream';
import stream = require('stream');
import http = require('http');
import net = require('net');
import getStream = require('get-stream');
import test from 'ava';
import delay = require('delay');
import CacheableLookup from 'cacheable-lookup';
import {Handler} from 'express';
import pEvent = require('p-event');
import got, {TimeoutError} from '../source';
import timedOut from '../source/core/utils/timed-out';
import slowDataStream from './helpers/slow-data-stream';
import {GlobalClock} from './helpers/types';
import withServer, {withServerAndLolex} from './helpers/with-server';

const pStreamPipeline = promisify(stream.pipeline);

const requestDelay = 800;

const errorMatcher = {
	instanceOf: got.TimeoutError,
	code: 'ETIMEDOUT'
};

const keepAliveAgent = new http.Agent({
	keepAlive: true
});

const defaultHandler = (clock: GlobalClock): Handler => (request, response) => {
	request.resume();
	request.on('end', () => {
		clock.tick(requestDelay);
		response.end('OK');
	});
};

const downloadHandler = (clock: GlobalClock): Handler => (_request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked'
	});
	response.flushHeaders();

	setImmediate(async () => {
		await pStreamPipeline(slowDataStream(clock), response);
	});
};

test.serial('timeout option', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: 1,
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms'
		}
	);
});

test.serial('timeout option as object', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {request: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms'
		}
	);
});

test.serial('socket timeout', async t => {
	await t.throwsAsync(
		got('https://example.com', {
			timeout: {socket: 1},
			retry: 0,
			request: () => {
				const stream = new PassThroughStream();
				// @ts-ignore Mocking the behaviour of a ClientRequest
				stream.setTimeout = (ms, callback) => {
					process.nextTick(callback);
				};

				// @ts-ignore Mocking the behaviour of a ClientRequest
				stream.abort = () => {};
				stream.resume();

				return stream as unknown as http.ClientRequest;
			}
		}),
		{
			instanceOf: got.TimeoutError,
			code: 'ETIMEDOUT',
			message: 'Timeout awaiting \'socket\' for 1ms'
		}
	);
});

test.serial('send timeout', withServerAndLolex, async (t, server, got, clock) => {
	server.post('/', defaultHandler(clock));

	await t.throwsAsync(
		got.post({
			timeout: {send: 1},
			body: new stream.PassThrough(),
			retry: 0
		}).on('request', request => {
			request.once('socket', socket => {
				socket.once('connect', () => {
					clock.tick(10);
				});
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms'
		}
	);
});

test.serial('send timeout (keepalive)', withServerAndLolex, async (t, server, got, clock) => {
	server.post('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});

	await t.throwsAsync(
		got.post({
			agent: {
				http: keepAliveAgent
			},
			timeout: {send: 1},
			retry: 0,
			body: slowDataStream(clock)
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
			message: 'Timeout awaiting \'send\' for 1ms'
		}
	);
});

test.serial('response timeout', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {response: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'response\' for 1ms'
		}
	);
});

test.serial('response timeout unaffected by slow upload', withServerAndLolex, async (t, server, got, clock) => {
	server.post('/', defaultHandler(clock));

	await t.notThrowsAsync(got.post({
		retry: 0,
		body: slowDataStream(clock)
	}));
});

test.serial('response timeout unaffected by slow download', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', downloadHandler(clock));

	await t.notThrowsAsync(got({
		timeout: {response: 200},
		retry: 0
	}));

	clock.tick(100);
});

test.serial('response timeout (keepalive)', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});

	const request = got({
		agent: {
			http: keepAliveAgent
		},
		timeout: {response: 1},
		retry: 0
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
		message: 'Timeout awaiting \'response\' for 1ms'
	});
});

test.serial('connect timeout', withServerAndLolex, async (t, _server, got, clock) => {
	await t.throwsAsync(
		got({
			createConnection: options => {
				const socket = new net.Socket(options as object as net.SocketConstructorOpts);
				// @ts-ignore We know that it is readonly, but we have to test it
				socket.connecting = true;
				setImmediate(() => {
					socket.emit('lookup', null, '127.0.0.1', 4, 'localhost');
				});
				return socket;
			},
			timeout: {connect: 1},
			retry: 0
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms'
		}
	);
});

test.serial('connect timeout (ip address)', withServerAndLolex, async (t, _server, got, clock) => {
	await t.throwsAsync(
		got({
			url: 'http://127.0.0.1',
			prefixUrl: '',
			createConnection: options => {
				const socket = new net.Socket(options as object as net.SocketConstructorOpts);
				// @ts-ignore We know that it is readonly, but we have to test it
				socket.connecting = true;
				return socket;
			},
			timeout: {connect: 1},
			retry: 0
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms'
		}
	);
});

test.serial('secureConnect timeout', withServerAndLolex, async (t, _server, got, clock) => {
	await t.throwsAsync(
		got.secure({
			createConnection: options => {
				const socket = new net.Socket(options as object as net.SocketConstructorOpts);
				// @ts-ignore We know that it is readonly, but we have to test it
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
			retry: 0
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'secureConnect\' for 0ms'
		}
	);
});

test('secureConnect timeout not breached', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.notThrowsAsync(got({
		timeout: {secureConnect: 200},
		retry: 0,
		rejectUnauthorized: false
	}));
});

test.serial('lookup timeout', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			// @ts-ignore Manual tests
			lookup: () => {},
			timeout: {lookup: 1},
			retry: 0
		}).on('request', (request: http.ClientRequest) => {
			request.on('socket', () => {
				clock.runAll();
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'lookup\' for 1ms'
		}
	);
});

test.serial('lookup timeout no error (ip address)', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.notThrowsAsync(got({
		url: `http://127.0.0.1:${server.port}`,
		prefixUrl: '',
		timeout: {lookup: 1},
		retry: 0
	}));
});

test.serial('lookup timeout no error (keepalive)', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});
	await t.notThrowsAsync(got({
		agent: {http: keepAliveAgent},
		timeout: {lookup: 1},
		retry: 0
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
		timeout: 1,
		retry: {
			calculateDelay: () => {
				if (hasTried) {
					return 0;
				}

				hasTried = true;
				return 1;
			}
		}
	}), {
		...errorMatcher,
		message: 'Timeout awaiting \'request\' for 1ms'
	});

	t.true(hasTried);
});

test.serial('timeout with streams', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const stream = got.stream({
		timeout: 0,
		retry: 0
	});
	await t.throwsAsync(pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});

test.serial('no error emitted when timeout is not breached (stream)', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const stream = got.stream({
		retry: 0,
		timeout: {
			request: requestDelay * 2
		}
	});

	await t.notThrowsAsync(getStream(stream));
});

test.serial('no error emitted when timeout is not breached (promise)', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.notThrowsAsync(got({
		retry: 0,
		timeout: {
			request: requestDelay * 2
		}
	}));
});

test.serial('no unhandled `socket hung up` errors', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({retry: 0, timeout: requestDelay / 2}),
		{instanceOf: got.TimeoutError}
	);
});

// TODO: use lolex here
test.serial('no unhandled timeout errors', withServer, async (t, _server, got) => {
	await t.throwsAsync(got({
		retry: 0,
		timeout: 100,
		request: (...args: any[]) => {
			// @ts-ignore
			const result = http.request(...args);

			result.once('socket', () => {
				result.socket.destroy();
			});

			return result;
		}
	}), {message: 'socket hang up'});

	await delay(200);
});

test.serial('no more timeouts after an error', withServer, async (t, _server, got) => {
	const {setTimeout} = global;
	const {clearTimeout} = global;

	// @ts-ignore
	global.setTimeout = (callback, _ms, ...args) => {
		const timeout = {
			isCleared: false
		};

		process.nextTick(() => {
			if (timeout.isCleared) {
				return;
			}

			callback(...args);
		});

		return timeout;
	};

	// @ts-ignore
	global.clearTimeout = timeout => {
		if (timeout) {
			// @ts-ignore
			timeout.isCleared = true;
		}
	};

	await t.throwsAsync(got(`http://${Date.now()}.dev`, {
		retry: 1,
		timeout: {
			lookup: 1,
			connect: 1,
			secureConnect: 1,
			socket: 1,
			response: 1,
			send: 1,
			request: 1
		}
	}), {instanceOf: got.TimeoutError});

	await delay(100);

	global.setTimeout = setTimeout;
	global.clearTimeout = clearTimeout;
});

test.serial('socket timeout is canceled on error', withServerAndLolex, async (t, _server, got, clock) => {
	const message = 'oh, snap!';

	const promise = got({
		timeout: {socket: 50},
		retry: 0
	}).on('request', (request: http.ClientRequest) => {
		request.destroy(new Error(message));
	});

	await t.throwsAsync(promise, {message});

	// Wait a bit more to check if there are any unhandled errors
	clock.tick(100);
});

test.serial('no memory leak when using socket timeout and keepalive agent', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const promise = got({
		agent: {http: keepAliveAgent},
		timeout: {socket: requestDelay * 2}
	});

	let socket!: net.Socket;
	promise.on('request', (request: http.ClientRequest) => {
		request.on('socket', () => {
			socket = request.socket;
		});
	});

	await promise;

	t.is(socket.listenerCount('timeout'), 0);

	keepAliveAgent.destroy();
});

test('ensure there are no new timeouts after cancelation', t => {
	const emitter = new EventEmitter();
	const socket = new EventEmitter();
	(socket as any).connecting = true;

	timedOut(emitter as http.ClientRequest, {
		connect: 1
	}, {
		hostname: '127.0.0.1'
	})();

	emitter.emit('socket', socket);
	socket.emit('lookup', null);
	t.is(socket.listenerCount('connect'), 0);
});

test('double calling timedOut has no effect', t => {
	const emitter = new EventEmitter();

	const attach = (): () => void => timedOut(emitter as http.ClientRequest, {
		connect: 1
	}, {
		hostname: '127.0.0.1'
	});

	attach();
	attach();

	t.is(emitter.listenerCount('socket'), 1);
});

test.serial('doesn\'t throw on early lookup', withServerAndLolex, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// @ts-ignore
	await t.notThrowsAsync(got('', {
		timeout: {
			lookup: 1
		},
		retry: 0,
		lookup: (...[_hostname, options, callback]: Parameters<CacheableLookup['lookup']>) => {
			if (typeof options === 'function') {
				callback = options;
			}

			// @ts-ignore This should be fixed in upstream
			callback(null, '127.0.0.1', 4);
		}
	}));
});

// TODO: use lolex here
test.serial('no unhandled `Premature close` error', withServer, async (t, server, got) => {
	server.get('/', async (_request, response) => {
		response.write('hello');
	});

	await t.throwsAsync(got({
		timeout: 10,
		retry: 0
	}), {message: 'Timeout awaiting \'request\' for 10ms'});

	await delay(20);
});

// TODO: use lolex here
test.serial('cancelling the request removes timeouts', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('hello');
	});

	const promise = got({
		timeout: 500,
		retry: 0
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
	const marginOfError = 100;

	const error = await t.throwsAsync<TimeoutError>(got('http://192.0.2.1/test', {
		retry: 0,
		timeout
	}), {instanceOf: TimeoutError});

	t.true(error.timings.phases.total! < (timeout + marginOfError));
});
