import process from 'node:process';
import {EventEmitter} from 'node:events';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import http from 'node:http';
import http2, {type ServerHttp2Stream} from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import getStream from 'get-stream';
import test from 'ava';
import delay from 'delay';
import type {Handler} from 'express';
import {pEvent} from 'p-event';
import pify from 'pify';
import pem from 'pem';
import got, {type RequestError, TimeoutError} from '../source/index.js';
import type {NativeRequestOptions} from '../source/core/options.js';
import timedOut from '../source/core/timed-out.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import slowDataStream from './helpers/slow-data-stream.js';
import type {GlobalClock} from './helpers/types.js';
import withServer, {withServerAndFakeTimers, withHttpsServer} from './helpers/with-server.js';
import type {CreateCertificate} from './types/pem.js';

const requestDelay = 800;
const createCertificate = pify(pem.createCertificate as CreateCertificate);

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

	setImmediate(() => {
		void streamPipeline(slowDataStream(clock), response);
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
			https: {
				rejectUnauthorized: false,
			},
			request() {
				return https.request('https://example.com', {
					timeout: 0,
					rejectUnauthorized: false,
				});
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

	let socketConnecting: boolean | undefined;
	let connectEventFired = false;

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
				socketConnecting = socket.connecting;

				socket.once('connect', () => {
					connectEventFired = true;
				});
			});
		}),
		{
			...errorMatcher,
			message: 'Timeout awaiting \'send\' for 1ms',
		},
	);

	t.false(socketConnecting);
	t.false(connectEventFired, '\'connect\' event fired, invalidating test');
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
			createConnection(_options: NativeRequestOptions) {
				const socket = new net.Socket();
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
		got('http://127.0.0.1', {
			createConnection(_options: NativeRequestOptions) {
				const socket = new net.Socket();
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
			createConnection(_options: NativeRequestOptions) {
				const socket = new net.Socket();
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

	await t.notThrowsAsync(got(`http://127.0.0.1:${server.port}`, {
		timeout: {lookup: 1},
		retry: {limit: 0},
	}));
});

test.serial('lookup timeout no error (keepalive)', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	let connectEventFired = false;

	await got('prime', {agent: {http: keepAliveAgent}});
	await t.notThrowsAsync(got({
		agent: {http: keepAliveAgent},
		timeout: {lookup: 1},
		retry: {limit: 0},
	}).on('request', (request: http.ClientRequest) => {
		request.once('connect', () => {
			connectEventFired = true;
		});
	}));

	t.false(connectEventFired, 'connect event fired, invalidating test');

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

test.serial('no unhandled timeout errors', withServerAndFakeTimers, async (t, _server, got, clock) => {
	await t.throwsAsync(got({
		retry: {limit: 0},
		timeout: {request: 100},
		request(...arguments_) {
			const result = http.request(...arguments_);

			result.once('socket', () => {
				result.socket?.destroy();
			});

			return result;
		},
	}), {message: 'socket hang up'});

	clock.tick(200);
});

test.serial('no unhandled timeout errors #2', withServerAndFakeTimers, async (t, server, got, clock) => {
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

	clock.tick(100);
});

test.serial('no more timeouts after an error', withServer, async (t, _server, got) => {
	const {setTimeout} = globalThis;
	const {clearTimeout} = globalThis;

	// @ts-expect-error FIXME
	globalThis.setTimeout = (callback, _ms, ...arguments_) => {
		const timeout = {
			isCleared: false,
		};

		process.nextTick(() => {
			if (timeout.isCleared) {
				return;
			}

			callback(...arguments_);
		});

		return timeout;
	};

	globalThis.clearTimeout = timeout => {
		if (timeout) {
			// @ts-expect-error FIXME
			timeout.isCleared = true;
		}
	};

	try {
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
	} finally {
		globalThis.setTimeout = setTimeout;
		globalThis.clearTimeout = clearTimeout;
	}
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

// Regression test for issue #857: Fast DNS lookups (e.g., from cache) that complete synchronously
// used to incorrectly trigger lookup timeouts because Got couldn't attach the 'lookup' event listener
// in time. The fix in commit 4faf5c7 checks if the lookup has already completed (socket.address() is
// defined) before setting a lookup timeout, preventing false timeout errors on cached/fast lookups.
test.serial('doesn\'t throw on early lookup', withServerAndFakeTimers, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.notThrowsAsync(got('', {
		timeout: {
			lookup: 1,
		},
		retry: {limit: 0},
		dnsLookup(_hostname, options, callback) {
			if (typeof options === 'function') {
				callback = options;
				// Call with default (non-all) signature
				callback(null, '127.0.0.1', 4);
			} else if (options.all) {
				// When options.all is true, callback expects an array of address objects
				callback(null, [{address: '127.0.0.1', family: 4}]);
			} else {
				callback(null, '127.0.0.1', 4);
			}
		},
	}));
});

test.serial('no unhandled `Premature close` error', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', async (_request, response) => {
		response.write('hello');
	});

	await t.throwsAsync(got({
		timeout: {request: 10},
		retry: {limit: 0},
	}), {message: 'Timeout awaiting \'request\' for 10ms'});

	clock.tick(20);
});

test.serial('`read` timeout - promise', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', (_request, response) => {
		response.write('o');
	});

	const gotPromise = got({
		timeout: {
			read: 10,
		},
		retry: {
			limit: 0,
		},
	});

	clock.tick(20);
	await t.throwsAsync(gotPromise, {message: 'Timeout awaiting \'read\' for 10ms'});
});

test.serial('`read` timeout - stream', withServerAndFakeTimers, async (t, server, got, clock) => {
	t.timeout(100);

	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const stream = got.stream({
		timeout: {
			read: 10,
		},
	});

	clock.tick(20);
	await t.throwsAsync(pEvent(stream, 'end'), {message: 'Timeout awaiting \'read\' for 10ms'});
});

test.serial('cancelling the request removes timeouts', withServerAndFakeTimers, async (t, server, got, clock) => {
	server.get('/', (_request, response) => {
		response.write('hello');
	});

	const controller = new AbortController();

	let unexpectedTimeoutError: string | undefined;

	const promise = got({
		signal: controller.signal,
		timeout: {
			request: 500,
		},
		retry: {
			limit: 0,
		},
	}).on('downloadProgress', () => {
		controller.abort();
	}).on('request', request => {
		request.on('error', error => {
			if (error.message === 'Timeout awaiting \'request\' for 500ms') {
				unexpectedTimeoutError = error.message;
			}
		});
	});

	await t.throwsAsync(promise, {message: 'This operation was aborted.'});
	t.is(unexpectedTimeoutError, undefined);

	clock.tick(1000);
});

test.serial('timeouts are emitted ASAP', withServer, async (t, server, got) => {
	server.get('/test', () => {
		// Never respond - forces a timeout
	});

	const timeout = 500;
	const marginOfError = process.env.CI ? 200 : 100;
	const startTime = Date.now();

	const error = await t.throwsAsync<TimeoutError>(got('test', {
		retry: {
			limit: 0,
		},
		timeout: {
			request: timeout,
		},
	}), {instanceOf: TimeoutError});

	const elapsed = Date.now() - startTime;
	t.true(elapsed < (timeout + marginOfError), `Expected timeout ${elapsed}ms to be less than ${timeout + marginOfError}ms`);
	t.true(error.timings.phases.total! < (timeout + marginOfError));
});

test('http2 timeout', async t => {
	let streamReceived!: () => void;
	const streamReceivedPromise = new Promise<void>(resolve => {
		streamReceived = resolve;
	});
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		streamReceived();
		stream.resume();
	});

	try {
		const promise = got(server.url, {
			timeout: {
				request: 100,
			},
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		});

		await streamReceivedPromise;
		const error = await t.throwsAsync<TimeoutError>(promise, errorMatcher);
		t.is(error?.event, 'request');
		const message = error?.message ?? '';
		t.regex(message, /^Timeout awaiting 'request' for \d+ms$/);
		const threshold = Number(/\d+/.exec(message)?.[0]);
		t.true(threshold > 0);
		t.true(threshold <= 100);
	} finally {
		await server.close();
	}
});

test('http2 socket timeout does not abort an active stream', async t => {
	const server = await createHttp2TestServer(async stream => {
		await delay(120);
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const {body} = await got(server.url, {
			http2: true,
			timeout: {
				socket: 50,
				request: 1000,
			},
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		});

		t.is(body, 'ok');
	} finally {
		await server.close();
	}
});

test('http2 ALPN negotiation obeys request timeout', async t => {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const error = await t.throwsAsync<TimeoutError>(got(`https://127.0.0.1:${port}`, {
			http2: true,
			timeout: {
				request: 50,
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		}), errorMatcher);

		t.is(error?.event, 'request');
		t.is(error?.message, 'Timeout awaiting \'request\' for 50ms');
		t.truthy(error?.timings);
		t.deepEqual(error?.timings?.phases, {
			total: 0,
		});
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 session setup after ALPN obeys timeout', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const http2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	http2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	await new Promise<void>(resolve => {
		http2Server.listen(0, 'localhost', resolve);
	});

	const {port} = http2Server.address() as net.AddressInfo;
	const url = `https://localhost:${port}`;

	await got(url, {
		http2: true,
		agent: {
			http2: false,
		},
		https: {
			rejectUnauthorized: false,
		},
	});
	await new Promise<void>((resolve, reject) => {
		http2Server.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});

	const sockets = new Set<tls.TLSSocket>();
	let alpnProtocol: tls.TLSSocket['alpnProtocol'] | undefined;
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
	}, socket => {
		alpnProtocol = socket.alpnProtocol ?? undefined;
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
		socket.resume();
	});

	await new Promise<void>(resolve => {
		server.listen(port, 'localhost', resolve);
	});

	try {
		const startTime = Date.now();
		const error = await t.throwsAsync<TimeoutError>(got(url, {
			http2: true,
			agent: {
				http2: false,
			},
			timeout: {
				secureConnect: 100,
			},
			signal: AbortSignal.timeout(300),
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		const elapsed = Date.now() - startTime;
		t.is(error?.event, 'request', `Got ${error?.event ?? 'undefined'} after ${elapsed}ms: ${error?.message ?? 'no message'}`);
		t.is(error?.message, 'Timeout awaiting \'request\' for 100ms');
		t.is(alpnProtocol, 'h2');
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 fallback keeps HTTP/1.1 socket timeout', withHttpsServer(), async (t, server, got) => {
	server.get('/', () => {});

	const {port} = new URL(server.url);
	const alpnProtocols = 'ALPNProtocols';

	await t.throwsAsync(got({
		http2: true,
		createConnection() {
			return tls.connect(Number(port), 'localhost', {
				[alpnProtocols]: ['h2', 'http/1.1'],
				rejectUnauthorized: false,
				servername: 'localhost',
			});
		},
		timeout: {
			socket: 100,
			request: 500,
		},
		retry: {
			limit: 0,
		},
		https: {
			rejectUnauthorized: false,
		},
	}), {
		...errorMatcher,
		message: 'Timeout awaiting \'socket\' for 100ms',
	});
});

test('http2 fallback does not use ALPN timeout as HTTP/1.1 socket timeout', withHttpsServer(), async (t, server, got) => {
	server.get('/', async (_request, response) => {
		await delay(120);
		response.end('ok');
	});

	const {body} = await got({
		http2: true,
		timeout: {
			lookup: 20,
			request: 1000,
		},
		retry: {
			limit: 0,
		},
	});

	t.is(body, 'ok');
});

test('http2 with custom HTTPS agent does not use ALPN timeout as HTTP/1.1 socket timeout', withHttpsServer(), async (t, server, got) => {
	server.get('/', async (_request, response) => {
		await delay(120);
		response.end('ok');
	});

	const agent = new https.Agent();

	try {
		const {body} = await got({
			http2: true,
			agent: {
				https: agent,
			},
			timeout: {
				lookup: 20,
				request: 1000,
			},
			retry: {
				limit: 0,
			},
		});

		t.is(body, 'ok');
	} finally {
		agent.destroy();
	}
});

test('http2 option on HTTP does not use ALPN timeout as socket timeout', withServer, async (t, server, got) => {
	server.get('/', async (_request, response) => {
		await delay(120);
		response.end('ok');
	});

	const {body} = await got({
		http2: true,
		timeout: {
			lookup: 20,
			request: 1000,
		},
		retry: {
			limit: 0,
		},
	});

	t.is(body, 'ok');
});

test('http2 ALPN negotiation treats zero request timeout as immediate', async t => {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const startTime = Date.now();
		const error = await t.throwsAsync<RequestError>(got(`https://127.0.0.1:${port}`, {
			http2: true,
			timeout: {
				request: 0,
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		}));

		const elapsed = Date.now() - startTime;
		t.is(error?.code, 'ETIMEDOUT');
		t.true(elapsed < 200, `Expected immediate timeout, got ${elapsed}ms`);
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('request timeout includes async custom request function time', withServer, async (t, server, got) => {
	server.get('/', () => {});

	const timeout = 100;
	const startTime = Date.now();
	const error = await t.throwsAsync<RequestError>(got({
		http2: true,
		timeout: {
			request: timeout,
		},
		retry: {
			limit: 0,
		},
		async request(url, options, callback) {
			await delay(80);
			return http.request(url, options, callback);
		},
	}));

	const elapsed = Date.now() - startTime;
	t.is(error?.code, 'ETIMEDOUT');
	t.true(elapsed < 170, `Expected timeout ${elapsed}ms to include async request function time`);
});

test('request timeout aborts slow async custom request function', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('too late');
	});

	const timeout = 50;
	const startTime = Date.now();
	const error = await t.throwsAsync<RequestError>(got({
		http2: true,
		timeout: {
			request: timeout,
		},
		retry: {
			limit: 0,
		},
		async request() {
			await delay(200);
			return undefined;
		},
	}));

	const elapsed = Date.now() - startTime;
	t.is(error?.code, 'ETIMEDOUT');
	t.true(elapsed < 150, `Expected timeout ${elapsed}ms to happen before custom request resolution`);
});

test('request timeout destroys late async custom request result', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('too late');
	});

	let lateRequest: http.ClientRequest | undefined;
	let resolveLateRequest!: () => void;
	const lateRequestCreated = new Promise<void>(resolve => {
		resolveLateRequest = resolve;
	});

	const error = await t.throwsAsync<RequestError>(got({
		timeout: {
			request: 50,
		},
		retry: {
			limit: 0,
		},
		async request(url, options, callback) {
			await delay(100);
			lateRequest = http.request(url, options, callback);
			resolveLateRequest();
			return lateRequest;
		},
	}));

	t.is(error?.code, 'ETIMEDOUT');

	try {
		await lateRequestCreated;
		await delay(20);
		t.true(lateRequest!.destroyed);
	} finally {
		lateRequest?.destroy();
	}
});

test('http2 custom request does not receive ALPN timeout', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let requestTimeout: NativeRequestOptions['timeout'] | undefined;
	const {body} = await got({
		http2: true,
		timeout: {
			request: 1000,
		},
		retry: {
			limit: 0,
		},
		request(_url, options) {
			requestTimeout = options.timeout;
			return undefined;
		},
	});

	t.is(body, 'ok');
	t.is(requestTimeout, undefined);
});

test('http2 async custom request fallback uses remaining request timeout for ALPN', async t => {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const timeout = 100;
		const startTime = Date.now();
		const error = await t.throwsAsync<RequestError>(got(`https://127.0.0.1:${port}`, {
			http2: true,
			timeout: {
				request: timeout,
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
			async request() {
				await delay(80);
				return undefined;
			},
		}));

		const elapsed = Date.now() - startTime;
		t.is(error?.code, 'ETIMEDOUT');
		t.true(elapsed < 170, `Expected fallback ALPN timeout ${elapsed}ms to include async request function time`);
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('async custom request timeout is restored between retries', withServer, async (t, server, got) => {
	let requestFunctionCalls = 0;
	let requests = 0;

	server.get('/', async (_request, response) => {
		requests++;

		if (requests === 1) {
			response.statusCode = 500;
			response.end('retry');
			return;
		}

		await delay(500);
		response.end('ok');
	});

	const {body, retryCount} = await got({
		http2: true,
		timeout: {
			request: 1200,
		},
		retry: {
			limit: 1,
			calculateDelay: ({computedValue}) => computedValue ? 1 : 0,
		},
		async request(url, options, callback) {
			requestFunctionCalls++;

			if (requestFunctionCalls === 1) {
				await delay(800);
			}

			return http.request(url, options, callback);
		},
	});

	t.is(body, 'ok');
	t.is(retryCount, 1);
	t.is(requestFunctionCalls, 2);
});

// Reproduces the memory leak reported in https://github.com/sindresorhus/got/issues/2351
test.serial('no memory leak when using http2 with socket timeout and connection reuse', async t => {
	const requestCount = 15; // Make concurrent requests to accumulate listeners
	let sharedSocket: any;
	let maxListenerCount = 0;
	const server = await createHttp2TestServer(async stream => {
		await delay(200);
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		await got(server.url, {
			http2: true,
			https: {rejectUnauthorized: false},
		});
		await got(server.url, {
			http2: true,
			https: {rejectUnauthorized: false},
		});

		const promises = [];
		const handleRequest = (request: any) => {
			t.true(request.isGotHttp2Request);
			request.once('socket', (socket: any) => {
				sharedSocket ??= socket;

				const currentCount = socket.listenerCount('timeout');
				if (currentCount > maxListenerCount) {
					maxListenerCount = currentCount;
				}
			});
		};

		for (let index = 0; index < requestCount; index++) {
			const promise = got(`${server.url}/slow/${index}`, {
				http2: true,
				timeout: {socket: 30_000},
				https: {rejectUnauthorized: false},
			}).on('request', handleRequest);
			promises.push(promise);
		}

		await Promise.all(promises);

		t.truthy(sharedSocket, 'Should have a socket');
		t.is(server.sessions.size, 1);

		// With the bug, timeout listeners grow with concurrent requests.
		t.true(maxListenerCount <= 2, `Socket peaked at ${maxListenerCount} timeout listeners (expected ≤ 2)`);
	} finally {
		await server.close();
	}
});
