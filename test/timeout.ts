import http from 'http';
import net from 'net';
import stream from 'stream';
import getStream from 'get-stream';
import test from 'ava';
import pEvent from 'p-event';
import delay from 'delay';
import got from '../source';
import withServer from './helpers/with-server';

const slowDataStream = () => {
	const slowStream = new stream.PassThrough();
	let count = 0;
	const interval = setInterval(() => {
		if (count++ < 10) {
			slowStream.push('data\n'.repeat(100));
			return;
		}

		clearInterval(interval);
		slowStream.push(null);
	}, 100);
	return slowStream;
};

const requestDelay = 750;
const requestTimeout = requestDelay - 50;

const errorMatcher = {
	instanceOf: got.TimeoutError,
	code: 'ETIMEDOUT'
};

const keepAliveAgent = new http.Agent({
	keepAlive: true
});

const defaultHandler = (request, response) => {
	request.resume();
	request.on('end', async () => {
		await delay(requestDelay);
		response.end('OK');
	});
};

const downloadHandler = (request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked'
	});
	response.flushHeaders();
	slowDataStream().pipe(response);
};

test('timeout option (ETIMEDOUT)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			timeout: 0,
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 0ms'
		}
	);
});

test('timeout option as object (ETIMEDOUT)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			timeout: {socket: requestDelay * 2.5, request: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms'
		}
	);
});

test('socket timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			timeout: {socket: requestTimeout},
			retry: 0
		}),
		{
			instanceOf: got.TimeoutError,
			code: 'ETIMEDOUT',
			message: `Timeout awaiting 'socket' for ${requestTimeout}ms`
		}
	);
});

test('send timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

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

test('send timeout (keepalive)', withServer, async (t, server, got) => {
	server.post('/', defaultHandler);
	server.get('/prime', (request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});
	await t.throwsAsync(
		got.post('', {
			agent: keepAliveAgent,
			timeout: {send: 1},
			retry: 0,
			body: slowDataStream()
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

test('response timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

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

test('response timeout unaffected by slow upload', withServer, async (t, server, got) => {
	server.post('/', defaultHandler);

	await got.post({
		timeout: {response: requestDelay * 2},
		retry: 0,
		body: slowDataStream()
	}).on('request', request => {
		request.on('error', error => {
			t.fail(`unexpected error: ${error}`);
		});
	});
	await delay(requestDelay * 3);
	t.pass('no error emitted');
});

test('response timeout unaffected by slow download', withServer, async (t, server, got) => {
	server.get('/download', downloadHandler);

	await got('download', {
		timeout: {response: 100},
		retry: 0
	}).on('request', request => {
		request.on('error', error => {
			t.fail(`unexpected error: ${error}`);
		});
	});
	await delay(requestDelay * 3);
	t.pass('no error emitted');
});

test('response timeout (keepalive)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/prime', (request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});
	await delay(100);
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

test('connect timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			host: server.hostname,
			port: server.port,
			createConnection: options => {
				const socket = new net.Socket(options);
				// @ts-ignore
				socket.connecting = true;
				setImmediate(
					socket.emit.bind(socket),
					'lookup',
					null,
					'127.0.0.1',
					4,
					'localhost'
				);
				return socket;
			}
		}, {
			timeout: {connect: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms'
		}
	);
});

test('connect timeout (ip address)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			hostname: '127.0.0.1',
			port: server.port,
			createConnection: options => {
				const socket = new net.Socket(options);
				// @ts-ignore
				socket.connecting = true;
				return socket;
			}
		}, {
			timeout: {connect: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'connect\' for 1ms'
		}
	);
});

test('secureConnect timeout', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	await t.throwsAsync(
		got.secure({
			timeout: {secureConnect: 1},
			retry: 0,
			rejectUnauthorized: false
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'secureConnect\' for 1ms'
		}
	);
});

test('secureConnect timeout not breached', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	const secureConnect = 200;
	await got({
		timeout: {secureConnect},
		retry: 0,
		rejectUnauthorized: false
	}).on('request', request => {
		request.on('error', error => {
			t.fail(`error emitted: ${error}`);
		});
	});
	await delay(secureConnect * 2);
	t.pass('no error emitted');
});

test('lookup timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			host: server.hostname,
			port: server.port,
			lookup: () => { }
		}, {
			timeout: {lookup: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'lookup\' for 1ms'
		}
	);
});

test('lookup timeout no error (ip address)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await got({
		hostname: '127.0.0.1',
		port: server.port,
		protocol: 'http:'
	}, {
		timeout: {lookup: 100},
		retry: 0
	}).on('request', request => {
		request.on('error', error => {
			t.fail(`error emitted: ${error}`);
		});
	});
	await delay(100);
	t.pass('no error emitted');
});

test('lookup timeout no error (keepalive)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/prime', (request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: keepAliveAgent});
	await got('', {
		agent: keepAliveAgent,
		timeout: {lookup: 100},
		retry: 0
	}).on('request', request => {
		request.once('connect', () => {
			t.fail('connect event fired, invalidating test');
		});
		request.on('error', error => {
			t.fail(`error emitted: ${error}`);
		});
	});
	await delay(100);
	t.pass('no error emitted');
});

test('request timeout', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(
		got({
			timeout: {request: requestTimeout},
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'request' for ${requestTimeout}ms`
		}
	);
});

test('retries on timeout (ESOCKETTIMEDOUT)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	let tried = false;
	await t.throwsAsync(got({
		timeout: requestTimeout,
		retry: {
			retries: () => {
				if (tried) {
					return 0;
				}

				tried = true;
				return 1;
			}
		}
	}), {
		...errorMatcher,
		message: `Timeout awaiting 'request' for ${requestTimeout}ms`
	});

	t.true(tried);
});

test('retries on timeout (ETIMEDOUT)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	let tried = false;
	await t.throwsAsync(got({
		timeout: 0,
		retry: {
			retries: () => {
				if (tried) {
					return 0;
				}

				tried = true;
				return 1;
			}
		}
	}), {...errorMatcher});

	t.true(tried);
});

test('timeout with streams', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream({
		timeout: 0,
		retry: 0
	});
	await t.throwsAsync(pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});

test('no error emitted when timeout is not breached (stream)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream({
		retry: 0,
		timeout: {
			request: requestDelay * 2
		}
	});
	stream.on('error', err => {
		t.fail(`error was emitted: ${err}`);
	});
	await getStream(stream);
	await delay(requestDelay * 3);
	t.pass();
});

test('no error emitted when timeout is not breached (promise)', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await got({
		retry: 0,
		timeout: {
			request: requestDelay * 2
		}
	}).on('request', request => {
		// 'error' events are not emitted by the Promise interface, so attach
		// directly to the request object
		request.on('error', error => {
			t.fail(`error was emitted: ${error}`);
		});
	});
	await delay(requestDelay * 3);
	t.pass();
});

test('no unhandled `socket hung up` errors', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(got({retry: 0, timeout: requestDelay / 2}), {instanceOf: got.TimeoutError});
	await delay(requestDelay);
});

test('no more timeouts after an error', async t => {
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
	}), {instanceOf: got.GotError}); // Don't check the message, because it may throw ENOTFOUND before the timeout.

	// Wait a bit more to check if there are any unhandled errors
	await delay(10);
});

test('socket timeout is canceled on error', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const message = 'oh, snap!';

	const promise = got({
		timeout: {socket: requestTimeout},
		retry: 0
	}).on('request', request => {
		request.emit('error', new Error(message));
		request.abort();
	});

	await t.throwsAsync(promise, {message});
	// Wait a bit more to check if there are any unhandled errors
	await delay(10);
});

test('no memory leak when using socket timeout and keepalive agent', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

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
