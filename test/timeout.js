import http from 'http';
import net from 'net';
import stream from 'stream';
import getStream from 'get-stream';
import test from 'ava';
import pEvent from 'p-event';
import delay from 'delay';
import got from '../source';
import {createServer, createSSLServer} from './helpers/server';

let s;
let ss;

const slowDataStream = () => {
	const slowStream = new stream.PassThrough();
	let count = 0;
	const interval = setInterval(() => {
		if (count++ < 10) {
			return slowStream.push('data\n'.repeat(100));
		}
		clearInterval(interval);
		slowStream.push(null);
	}, 100);
	return slowStream;
};

const requestDelay = 750;
const requestTimeout = requestDelay - 30;

const errorMatcher = {
	instanceOf: got.TimeoutError,
	code: 'ETIMEDOUT'
};

const keepAliveAgent = new http.Agent({
	keepAlive: true
});

test.before('setup', async () => {
	[s, ss] = await Promise.all([createServer(), createSSLServer()]);

	s.on('/', (request, response) => {
		request.on('data', () => {});
		request.on('end', async () => {
			await delay(requestDelay);
			response.end('OK');
		});
	});

	s.on('/download', (request, response) => {
		response.writeHead(200, {
			'transfer-encoding': 'chunked'
		});
		response.flushHeaders();
		slowDataStream().pipe(response);
	});

	s.on('/prime', (request, response) => {
		response.end('OK');
	});

	ss.on('/', (request, response) => {
		response.end('OK');
	});

	await Promise.all([s.listen(s.port), ss.listen(ss.port)]);
});

test('timeout option (ETIMEDOUT)', async t => {
	await t.throwsAsync(
		got(s.url, {
			timeout: 0,
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 0ms'
		}
	);
});

test('timeout option as object (ETIMEDOUT)', async t => {
	await t.throwsAsync(
		got(s.url, {
			timeout: {socket: requestDelay * 2.5, request: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'request\' for 1ms'
		}
	);
});

test('socket timeout', async t => {
	await t.throwsAsync(
		got(s.url, {
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

test('send timeout', async t => {
	await t.throwsAsync(
		got(s.url, {
			timeout: {send: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms'
		}
	);
});

test('send timeout (keepalive)', async t => {
	await got(`${s.url}/prime`, {agent: keepAliveAgent});
	await t.throwsAsync(
		got(s.url, {
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

test('response timeout', async t => {
	await t.throwsAsync(
		got(s.url, {
			timeout: {response: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'response\' for 1ms'
		}
	);
});

test('response timeout unaffected by slow upload', async t => {
	await got(s.url, {
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

test('response timeout unaffected by slow download', async t => {
	await got(`${s.url}/download`, {
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

test('response timeout (keepalive)', async t => {
	await got(`${s.url}/prime`, {agent: keepAliveAgent});
	await delay(100);
	const request = got(s.url, {
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

test('connect timeout', async t => {
	await t.throwsAsync(
		got({
			host: s.host,
			port: s.port,
			createConnection: options => {
				const socket = new net.Socket(options);
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

test('connect timeout (ip address)', async t => {
	await t.throwsAsync(
		got({
			hostname: '127.0.0.1',
			port: s.port,
			createConnection: options => {
				const socket = new net.Socket(options);
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

test('secureConnect timeout', async t => {
	await t.throwsAsync(
		got(ss.url, {
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

test('secureConnect timeout not breached', async t => {
	const secureConnect = 200;
	await got(ss.url, {
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

test('lookup timeout', async t => {
	await t.throwsAsync(
		got({
			host: s.host,
			port: s.port,
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

test('lookup timeout no error (ip address)', async t => {
	await got({
		hostname: '127.0.0.1',
		port: s.port
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

test('lookup timeout no error (keepalive)', async t => {
	await got(`${s.url}/prime`, {agent: keepAliveAgent});
	await got(s.url, {
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

test('request timeout', async t => {
	await t.throwsAsync(
		got(s.url, {
			timeout: {request: requestTimeout},
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'request' for ${requestTimeout}ms`
		}
	);
});

test('retries on timeout (ESOCKETTIMEDOUT)', async t => {
	let tried = false;

	await t.throwsAsync(got(s.url, {
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

test('retries on timeout (ETIMEDOUT)', async t => {
	let tried = false;

	await t.throwsAsync(got(s.url, {
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

test('timeout with streams', async t => {
	const stream = got.stream(s.url, {
		timeout: 0,
		retry: 0
	});
	await t.throwsAsync(pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});

test('no error emitted when timeout is not breached (stream)', async t => {
	const stream = got.stream(s.url, {
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

test('no error emitted when timeout is not breached (promise)', async t => {
	await got(s.url, {
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
