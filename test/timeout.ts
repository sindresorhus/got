import {promisify} from 'util';
import EventEmitter = require('events');
import {PassThrough as PassThroughStream} from 'stream';
import stream = require('stream');
import http = require('http');
import net = require('net');
import getStream = require('get-stream');
import test from 'ava';
import pEvent = require('p-event');
import got from '../source';
import timedOut from '../source/utils/timed-out';
import withServer, {withServerAndLolex} from './helpers/with-server';
import slowDataStream from './helpers/slow-data-stream';

const pStreamPipeline = promisify(stream.pipeline);

const requestDelay = 800;

const errorMatcher = {
	instanceOf: got.TimeoutError,
	code: 'ETIMEDOUT'
};

const keepAliveAgent = new http.Agent({
	keepAlive: true
});

const defaultHandler = clock => (request, response) => {
	request.resume();
	request.on('end', () => {
		clock.tick(requestDelay);
		response.end('OK');
	});
};

const downloadHandler = clock => (_request, response) => {
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
			// @ts-ignore
			request: () => {
				const stream = new PassThroughStream();
				// @ts-ignore
				stream.setTimeout = (ms, callback) => {
					callback();
				};

				// @ts-ignore
				stream.abort = () => {};
				stream.resume();

				return stream;
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
	server.get('/', defaultHandler(clock));

	await t.throwsAsync(
		got({
			timeout: {send: 1},
			retry: 0
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

	await got('prime', {agent: keepAliveAgent});

	await t.throwsAsync(
		got.post({
			agent: keepAliveAgent,
			timeout: {send: 1},
			retry: 0,
			body: slowDataStream(clock)
		}).on('request', request => {
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

	await got('prime', {agent: keepAliveAgent});

	const request = got({
		agent: keepAliveAgent,
		timeout: {response: 1},
		retry: 0
	}).on('request', request => {
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
				// @ts-ignore
				const socket = new net.Socket(options);
				// @ts-ignore
				socket.connecting = true;
				setImmediate(() => {
					socket.emit('lookup', null, '127.0.0.1', 4, 'localhost');
				});
				return socket;
			},
			timeout: {connect: 1},
			retry: 0
		}).on('request', request => {
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
			hostname: '127.0.0.1',
			createConnection: options => {
				const socket = new net.Socket(options);
				// @ts-ignore
				socket.connecting = true;
				return socket;
			},
			timeout: {connect: 1},
			retry: 0
		}).on('request', request => {
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
				// @ts-ignore
				const socket = new net.Socket(options);
				// @ts-ignore
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
		}).on('request', request => {
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
			lookup: () => {},
			timeout: {lookup: 1},
			retry: 0
		}).on('request', request => {
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
		hostname: '127.0.0.1',
		timeout: {lookup: 1},
		retry: 0
	}));
});

test.serial('lookup timeout no error (keepalive)', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});
	await t.notThrowsAsync(got({
		agent: keepAliveAgent,
		timeout: {lookup: 1},
		retry: 0
	}).on('request', request => {
		request.once('connect', () => {
			t.fail('connect event fired, invalidating test');
		});
	}));
});

test.serial('retries on timeout', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	let tried = false;
	await t.throwsAsync(got({
		timeout: 1,
		retry: {
			calculateDelay: () => {
				if (tried) {
					return 0;
				}

				tried = true;
				return 1;
			}
		}
	}), {
		...errorMatcher,
		message: 'Timeout awaiting \'request\' for 1ms'
	});

	t.true(tried);
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

test.serial('no more timeouts after an error', withServerAndLolex, async (t, _server, got, clock) => {
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
	}).on('request', () => {
		clock.runAll();
	}), {instanceOf: got.GotError});

	// Wait a bit more to check if there are any unhandled errors
	clock.tick(100);
});

test.serial('socket timeout is canceled on error', withServerAndLolex, async (t, _server, got, clock) => {
	const message = 'oh, snap!';

	const promise = got({
		timeout: {socket: 50},
		retry: 0
	}).on('request', request => {
		request.emit('error', new Error(message));
		request.abort();
	});

	await t.throwsAsync(promise, {message});

	// Wait a bit more to check if there are any unhandled errors
	clock.tick(100);
});

test.serial('no memory leak when using socket timeout and keepalive agent', withServerAndLolex, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const promise = got({
		agent: keepAliveAgent,
		timeout: {socket: requestDelay * 2}
	});

	let socket;
	promise.on('request', request => {
		request.on('socket', () => {
			socket = request.socket;
		});
	});

	await promise;

	t.is(socket.listenerCount('timeout'), 0);
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

	const attach = () => timedOut(emitter as http.ClientRequest, {
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

	await t.notThrowsAsync(got('', {
		timeout: {
			lookup: 1
		},
		retry: 0,
		lookup: (_hostname, options, callback) => {
			if (typeof options === 'function') {
				callback = options;
			}

			callback(null, '127.0.0.1', 4);
		}
	}));
});
