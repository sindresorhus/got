import http from 'http';
import net from 'net';
import stream from 'stream';
import getStream from 'get-stream';
import test from 'ava';
import pEvent from 'p-event';
import delay from 'delay';
import got from '../source';
import {createServer} from './helpers/server';

let s;
const reqDelay = 250;
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
const reqTimeout = reqDelay - 10;
const errorMatcher = {
	instanceOf: got.TimeoutError,
	code: 'ETIMEDOUT'
};
const keepAliveAgent = new http.Agent({
	keepAlive: true
});

test.before('setup', async () => {
	s = await createServer();

	s.on('/', async (req, res) => {
		req.on('data', () => {});
		req.on('end', async () => {
			await delay(reqDelay);
			res.end('OK');
		});
	});

	s.on('/download', async (req, res) => {
		res.writeHead(200, {
			'transfer-encoding': 'chunked'
		});
		res.flushHeaders();
		slowDataStream().pipe(res);
	});

	s.on('/prime', (req, res) => {
		res.end('OK');
	});

	await s.listen(s.port);
});

test('timeout option (ETIMEDOUT)', async t => {
	await t.throws(
		got(s.url, {
			timeout: 0,
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'request' for 0ms`
		}
	);
});

test('timeout option as object (ETIMEDOUT)', async t => {
	await t.throws(
		got(s.url, {
			timeout: {socket: reqDelay * 2.5, request: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'request' for 1ms`
		}
	);
});

test('socket timeout', async t => {
	await t.throws(
		got(s.url, {
			timeout: {socket: reqTimeout},
			retry: 0
		}),
		{
			instanceOf: got.TimeoutError,
			code: 'ETIMEDOUT',
			message: `Timeout awaiting 'socket' for ${reqTimeout}ms`
		}
	);
});

test('send timeout', async t => {
	await t.throws(
		got(s.url, {
			timeout: {send: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'send' for 1ms`
		}
	);
});

test('send timeout (keepalive)', async t => {
	await got(`${s.url}/prime`, {agent: keepAliveAgent});
	await t.throws(
		got(s.url, {
			agent: keepAliveAgent,
			timeout: {send: 1},
			retry: 0,
			body: slowDataStream()
		}).on('request', req => {
			req.once('socket', socket => {
				t.false(socket.connecting);
				socket.once('connect', () => {
					t.fail(`'connect' event fired, invalidating test`);
				});
			});
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'send' for 1ms`
		}
	);
});

test('response timeout', async t => {
	await t.throws(
		got(s.url, {
			timeout: {response: 1},
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'response' for 1ms`
		}
	);
});

test('response timeout unaffected by slow upload', async t => {
	await got(s.url, {
		timeout: {response: reqDelay * 2},
		retry: 0,
		body: slowDataStream()
	}).on('request', request => {
		request.on('error', error => {
			t.fail(`unexpected error: ${error}`);
		});
	});
	await delay(reqDelay * 3);
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
	await delay(reqDelay * 3);
	t.pass('no error emitted');
});

test('response timeout (keepalive)', async t => {
	await got(`${s.url}/prime`, {agent: keepAliveAgent});
	await delay(100);
	const request = got(s.url, {
		agent: keepAliveAgent,
		timeout: {response: 1},
		retry: 0
	}).on('request', req => {
		req.once('socket', socket => {
			t.false(socket.connecting);
			socket.once('connect', () => {
				t.fail(`'connect' event fired, invalidating test`);
			});
		});
	});
	await t.throws(request, {
		...errorMatcher,
		message: `Timeout awaiting 'response' for 1ms`
	});
});

test('connect timeout', async t => {
	await t.throws(
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
			message: `Timeout awaiting 'connect' for 1ms`
		}
	);
});

test('connect timeout (ip address)', async t => {
	await t.throws(
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
			message: `Timeout awaiting 'connect' for 1ms`
		}
	);
});

test('lookup timeout', async t => {
	await t.throws(
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
			message: `Timeout awaiting 'lookup' for 1ms`
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
	await t.throws(
		got(s.url, {
			timeout: {request: reqTimeout},
			retry: 0
		}),
		{
			...errorMatcher,
			message: `Timeout awaiting 'request' for ${reqTimeout}ms`
		}
	);
});

test('retries on timeout (ESOCKETTIMEDOUT)', async t => {
	let tried = false;

	await t.throws(got(s.url, {
		timeout: reqTimeout,
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
		message: `Timeout awaiting 'request' for ${reqTimeout}ms`
	});

	t.true(tried);
});

test('retries on timeout (ETIMEDOUT)', async t => {
	let tried = false;

	await t.throws(got(s.url, {
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
	await t.throws(pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});

test('no error emitted when timeout is not breached (stream)', async t => {
	const stream = got.stream(s.url, {
		retry: 0,
		timeout: {
			request: reqDelay * 2
		}
	});
	stream.on('error', err => {
		t.fail(`error was emitted: ${err}`);
	});
	await getStream(stream);
	await delay(reqDelay * 3);
	t.pass();
});

test('no error emitted when timeout is not breached (promise)', async t => {
	await got(s.url, {
		retry: 0,
		timeout: {
			request: reqDelay * 2
		}
	}).on('request', req => {
		// 'error' events are not emitted by the Promise interface, so attach
		// directly to the request object
		req.on('error', err => {
			t.fail(`error was emitted: ${err}`);
		});
	});
	await delay(reqDelay * 3);
	t.pass();
});
