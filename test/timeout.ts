import process from 'node:process';
import {Buffer} from 'node:buffer';
import zlib from 'node:zlib';
import {EventEmitter, once} from 'node:events';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import http from 'node:http';
import http2, {type ServerHttp2Stream} from 'node:http2';
import https from 'node:https';
import net, {type LookupFunction} from 'node:net';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import delay from 'delay';
import type {Handler} from 'express';
import getStream from 'get-stream';
import FakeTimers from '@sinonjs/fake-timers';
import pem from 'pem';
import got, {TimeoutError} from '../source/index.js';
import type {NativeRequestOptions} from '../source/core/options.js';
import timedOut from '../source/core/timed-out.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import slowDataStream from './helpers/slow-data-stream.js';
import type {GlobalClock} from './helpers/types.js';
import withServer, {withServerAndFakeTimers, withHttpsServer} from './helpers/with-server.js';
import type {CreateCertificate} from './types/pem.js';

const requestDelay = 800;
const createCertificate = promisify(pem.createCertificate as CreateCertificate);

const errorMatcher = errorMatching(TimeoutError, {code: 'ETIMEDOUT'});

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

test.serial('timeout option', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.rejects(
		got({
			timeout: {
				request: 1,
			},
			retry: {
				limit: 0,
			},
		}),
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'request\' for 1ms'}),
	);
});

test.serial('timeout option as object', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.rejects(
		got({
			timeout: {request: 1},
			retry: {
				limit: 0,
			},
		}),
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'request\' for 1ms'}),
	);
});

test.serial('socket timeout', async _t => {
	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'socket\' for 1ms'}),
	);
});

test.serial('send timeout', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.post('/', defaultHandler(clock));

	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'send\' for 1ms'}),
	);
});

test.serial('send timeout (keepalive)', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.post('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	await got('prime', {agent: {http: keepAliveAgent}});

	let socketConnecting: boolean | undefined;
	let connectEventFired = false;

	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'send\' for 1ms'}),
	);

	assert.strictEqual(socketConnecting, false);
	assert.strictEqual(connectEventFired, false, '\'connect\' event fired, invalidating test');
});

test.serial('response timeout', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.rejects(
		got({
			timeout: {response: 1},
			retry: {
				limit: 0,
			},
		}),
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'response\' for 1ms'}),
	);
});

test.serial('response timeout unaffected by slow upload', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.post('/', defaultHandler(clock));

	await assert.doesNotReject(got.post({
		retry: {
			limit: 0,
		},
		body: slowDataStream(clock),
	}));
});

test.serial('response timeout unaffected by slow download', withServer, async (_t, server, got) => {
	server.get('/', downloadHandler());

	await assert.doesNotReject(got({
		timeout: {response: 200},
		retry: {
			limit: 0,
		},
	}));

	await delay(100);
});

test.serial('response timeout (keepalive)', withServerAndFakeTimers, async (_t, server, got, clock) => {
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
			assert.strictEqual(socket.connecting, false);
			socket.once('connect', () => {
				assert.fail('\'connect\' event fired, invalidating test');
			});
		});
	});

	await assert.rejects(request, errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'response\' for 1ms'}));
});

test.serial('connect timeout', withServerAndFakeTimers, async (_t, _server, got, clock) => {
	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'connect\' for 1ms'}),
	);
});

test.serial('connect timeout (ip address)', withServerAndFakeTimers, async (_t, _server, _got, clock) => {
	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'connect\' for 1ms'}),
	);
});

test.serial('secureConnect timeout', withHttpsServer({}, true), async (_t, _server, got, clock) => {
	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'secureConnect\' for 0ms'}),
	);
});

test('secureConnect timeout not breached', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await assert.doesNotReject(got({
		timeout: {secureConnect: 200},
		retry: {
			limit: 0,
		},
		https: {
			rejectUnauthorized: false,
		},
	}));
});

test.serial('lookup timeout', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.rejects(
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
		errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'lookup\' for 1ms'}),
	);
});

test.serial('lookup timeout no error (ip address)', withServerAndFakeTimers, async (_t, server, _got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.doesNotReject(got(`http://127.0.0.1:${server.port}`, {
		timeout: {lookup: 1},
		retry: {limit: 0},
	}));
});

test.serial('lookup timeout no error (keepalive)', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));
	server.get('/prime', (_request, response) => {
		response.end('ok');
	});

	let connectEventFired = false;

	await got('prime', {agent: {http: keepAliveAgent}});
	await assert.doesNotReject(got({
		agent: {http: keepAliveAgent},
		timeout: {lookup: 1},
		retry: {limit: 0},
	}).on('request', (request: http.ClientRequest) => {
		request.once('connect', () => {
			connectEventFired = true;
		});
	}));

	assert.strictEqual(connectEventFired, false, 'connect event fired, invalidating test');

	keepAliveAgent.destroy();
});

test.serial('retries on timeout', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	let hasTried = false;
	await assert.rejects(got({
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
	}), errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'request\' for 1ms'}));

	assert.strictEqual(hasTried, true);
});

test.serial('timeout with streams', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const stream = got.stream({
		timeout: {request: 0},
		retry: {limit: 0},
	});
	await assert.rejects(once(stream, 'response'), {code: 'ETIMEDOUT'});
});

test.serial('no error emitted when timeout is not breached (stream)', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	const stream = got.stream({
		retry: {
			limit: 0,
		},
		timeout: {
			request: requestDelay * 2,
		},
	});

	await assert.doesNotReject(getStream(stream));
});

test.serial('no error emitted when timeout is not breached (promise)', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.doesNotReject(got({
		retry: {
			limit: 0,
		},
		timeout: {
			request: requestDelay * 2,
		},
	}));
});

test.serial('no unhandled `socket hung up` errors', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	await assert.rejects(
		got({
			retry: {
				limit: 0,
			},
			timeout: {
				request: requestDelay / 2,
			},
		}),
		TimeoutError,
	);
});

test.serial('no unhandled timeout errors', withServerAndFakeTimers, async (_t, _server, got, clock) => {
	await assert.rejects(got({
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

test.serial('no unhandled timeout errors #2', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', (_request, response) => {
		response.write('Hello world!');
	});

	const gotPromise = got('', {
		timeout: {
			request: 20,
		},
		retry: {
			calculateDelay({computedValue}) {
				return computedValue ? 10 : 0;
			},
			limit: 1,
		},
	});

	await assert.rejects(gotPromise, TimeoutError);

	clock.tick(100);
});

test.serial('no more timeouts after an error', withServer, async (_t, _server, got) => {
	const {setTimeout} = globalThis;
	const {clearTimeout} = globalThis;

	// @ts-expect-error FIXME
	globalThis.setTimeout = (callback, _ms, ...arguments_) => {
		const timeout = {
			isCleared: false,
			unref() {
				return timeout;
			},
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
		await assert.rejects(got(`http://${Date.now()}.dev`, {
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
		}), TimeoutError);

		await delay(100);
	} finally {
		globalThis.setTimeout = setTimeout;
		globalThis.clearTimeout = clearTimeout;
	}
});

test.serial('socket timeout is canceled on error', withServerAndFakeTimers, async (_t, _server, got, clock) => {
	const message = 'oh, snap!';

	const promise = got({
		timeout: {socket: 50},
		retry: {limit: 0},
	}).on('request', (request: http.ClientRequest) => {
		request.destroy(new Error(message));
	});

	await assert.rejects(promise, {message});

	// Wait a bit more to check if there are any unhandled errors
	clock.tick(100);
});

test.serial('no memory leak when using socket timeout and keepalive agent', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', defaultHandler(clock));

	let request: any;

	await got({
		agent: {http: keepAliveAgent},
		timeout: {socket: requestDelay * 2},
	}).on('request', _request => {
		request = _request;
	});

	assert.strictEqual(request.timeoutCb, null);

	keepAliveAgent.destroy();
});

test('ensure there are no new timeouts after cancelation', _t => {
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
	assert.strictEqual(socket.listenerCount('connect'), 0);
});

test('double calling timedOut has no effect', _t => {
	const emitter = new EventEmitter();

	const attach = (): () => void => timedOut(emitter as http.ClientRequest, {
		connect: 1,
	}, {
		hostname: '127.0.0.1',
	});

	attach();
	attach();

	assert.strictEqual(emitter.listenerCount('socket'), 1);
});

// Regression test for issue #857: Fast DNS lookups (e.g., from cache) that complete synchronously
// used to incorrectly trigger lookup timeouts because Got couldn't attach the 'lookup' event listener
// in time. The fix in commit 4faf5c7 checks if the lookup has already completed (socket.address() is
// defined) before setting a lookup timeout, preventing false timeout errors on cached/fast lookups.
test.serial('doesn\'t throw on early lookup', withServerAndFakeTimers, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await assert.doesNotReject(got('', {
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

test.serial('no unhandled `Premature close` error', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', async (_request, response) => {
		response.write('hello');
	});

	await assert.rejects(got({
		timeout: {request: 10},
		retry: {limit: 0},
	}), {message: 'Timeout awaiting \'request\' for 10ms'});

	clock.tick(20);
});

test.serial('`read` timeout - promise', withServerAndFakeTimers, async (_t, server, got, clock) => {
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
	await assert.rejects(gotPromise, {message: 'Timeout awaiting \'read\' for 10ms'});
});

test.serial('`read` timeout - stream', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', (_request, response) => {
		response.write('o');
	});

	const stream = got.stream({
		timeout: {
			read: 10,
		},
	});

	clock.tick(20);
	await assert.rejects(once(stream, 'end'), {message: 'Timeout awaiting \'read\' for 10ms'});
});

test.serial('cancelling the request removes timeouts', withServerAndFakeTimers, async (_t, server, got, clock) => {
	server.get('/', (_request, response) => {
		response.write('hello');
	});

	const controller = new AbortController();

	let unexpectedTimeoutError: string | undefined;

	const promise = got({
		signal: controller.signal,
		timeout: {
			// This test uses fake timers, so the budget stays small enough for `clock.tick(1000)`.
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

	await assert.rejects(promise, {message: 'This operation was aborted.'});
	assert.strictEqual(unexpectedTimeoutError, undefined);

	clock.tick(1000);
});

test.serial('timeouts are emitted ASAP', withServer, async (_t, server, got) => {
	server.get('/test', () => {
		// Never respond - forces a timeout
	});

	const timeout = 500;
	// This only catches a timeout that fires more than a second late, such as one that waits for
	// another phase. A machine under load can stretch the firing by far more than the timer
	// itself, so a bound tight enough to catch smaller added latency also fails without one.
	const marginOfError = process.env.CI ? 2000 : 1000;
	const startTime = Date.now();

	const error = await rejects(got('test', {
		retry: {
			limit: 0,
		},
		timeout: {
			request: timeout,
		},
	}), TimeoutError);

	const elapsed = Date.now() - startTime;
	assert.strictEqual(elapsed < (timeout + marginOfError), true, `Expected timeout ${elapsed}ms to be less than ${timeout + marginOfError}ms`);
	assert.strictEqual(error.timings.phases.total! < (timeout + marginOfError), true);
});

test('http2 timeout', async _t => {
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
		// The server never answers, so the request always runs out. The budget only has to outlast
		// the TLS handshake and the HTTP/2 negotiation, which a busy machine can make slow.
		const timeout = 2000;
		const promise = got(server.url, {
			timeout: {
				request: timeout,
			},
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		});

		const errorPromise = rejects(promise, errorMatcher);
		const waitForStream = async () => {
			await streamReceivedPromise;

			return true;
		};

		const waitForTimeout = async () => {
			await errorPromise;

			return false;
		};

		const streamWasReceived = await Promise.race([
			waitForStream(),
			waitForTimeout(),
		]);
		assert.strictEqual(streamWasReceived, true, 'Expected the HTTP/2 stream to be established before the request timed out');
		const error = await errorPromise;
		assert.strictEqual(error?.event, 'request');
		const message = error?.message ?? '';
		assert.match(message, /^Timeout awaiting 'request' for \d+ms$/v);
		const threshold = Number(/\d+/v.exec(message)?.[0]);
		assert.strictEqual(threshold > 0, true);
		assert.strictEqual(threshold <= timeout, true);
	} finally {
		await server.close();
	}
});

test('http2 socket timeout does not abort an active stream', async _t => {
	// The socket timeout is an inactivity budget, so the whole transfer must outlast it while no
	// single gap between chunks comes close. The chunks are paced from one interval rather than a
	// loop of awaited delays, because a slow tick would then add to every tick after it and the
	// gaps would creep up on the timeout under load.
	const totalChunks = 15;
	const chunkInterval = 100;
	const socketTimeout = 1000;

	let chunksSent = 0;
	const server = await createHttp2TestServer(async stream => {
		stream.respond({

			':status': 200,
		});

		await new Promise<void>(resolve => {
			const interval = setInterval(() => {
				if (chunksSent === totalChunks) {
					clearInterval(interval);
					stream.end('ok');
					resolve();
					return;
				}

				stream.write('chunk');
				chunksSent++;
			}, chunkInterval);

			// A reset or an error ends the wait, so the interval cannot outlive the test and leave
			// the server close hanging on this handler.
			const finish = () => {
				clearInterval(interval);
				resolve();
			};

			stream.once('close', finish);
			stream.once('error', finish);
		});
	});

	try {
		const {body} = await got(server.url, {
			http2: true,
			timeout: {
				socket: socketTimeout,
				request: 10_000,
			},
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		});

		assert.strictEqual(body, 'chunk'.repeat(totalChunks) + 'ok');
	} finally {
		await server.close();
	}
});

test('http2 ALPN negotiation obeys request timeout', async _t => {
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
		const error = await rejects(got(`https://127.0.0.1:${port}`, {
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

		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(error?.message, 'Timeout awaiting \'request\' for 50ms');
		assert.ok(error?.timings);
		assert.deepStrictEqual(error?.timings?.phases, {
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

test('http2 socket timeout applies during stalled TLS negotiation', async _t => {
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
		const error = await rejects(got(`https://127.0.0.1:${port}`, {
			http2: true,
			timeout: {
				// The handshake never completes, so this only has to fire before the abort signal
				// below. A busy event loop delays both timers, and a signal set too close would win.
				socket: 200,
			},
			signal: AbortSignal.timeout(3000),
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		}), errorMatcher);

		assert.strictEqual(error?.event, 'socket');
		assert.strictEqual(error?.message, 'Timeout awaiting \'socket\' for 200ms');
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

test('http2 socket timeout excludes DNS lookup time', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});
	const serverAddress = server.server.address() as net.AddressInfo;
	let lookupAddress = serverAddress.address;
	if (lookupAddress === '::') {
		lookupAddress = '::1';
	} else if (lookupAddress === '0.0.0.0') {
		lookupAddress = '127.0.0.1';
	}

	const lookupFamily = net.isIP(lookupAddress);
	const dnsLookup = ((_hostname: string, options: any, callback: any) => {
		setTimeout(() => {
			if (options.all) {
				callback(undefined, [{address: lookupAddress, family: lookupFamily}]);
				return;
			}

			callback(undefined, lookupAddress, lookupFamily);
		}, 1000);
	}) as LookupFunction;

	try {
		const makeRequest = async () => got(server.url, {
			http2: true,
			agent: {
				http2: false,
			},
			dnsLookup,
			timeout: {
				socket: 500,
				request: 5000,
			},
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		});

		assert.strictEqual((await makeRequest()).body, 'ok');
		assert.strictEqual((await makeRequest()).body, 'ok');
	} finally {
		await server.close();
	}
});

test('http2 session setup after ALPN obeys request and socket timeouts', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const http2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	http2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({

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
		const error = await rejects(got(url, {
			http2: true,
			agent: {
				http2: false,
			},
			timeout: {
				secureConnect: 500,
			},
			signal: AbortSignal.timeout(3000),
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		assert.strictEqual(error?.event, 'secureConnect', `Got ${error?.event ?? 'undefined'}: ${error?.message ?? 'no message'}`);
		assert.strictEqual(error?.message, 'Timeout awaiting \'secureConnect\' for 500ms');
		assert.strictEqual(alpnProtocol, 'h2');

		const socketError = await rejects(got(url, {
			http2: true,
			agent: {
				http2: false,
			},
			timeout: {
				socket: 500,
			},
			signal: AbortSignal.timeout(3000),
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		assert.strictEqual(socketError?.event, 'socket');
		assert.strictEqual(socketError?.message, 'Timeout awaiting \'socket\' for 500ms');
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

test('http2 fallback keeps HTTP/1.1 socket timeout', withHttpsServer(), async (_t, server, got) => {
	server.get('/', () => {});

	const {port} = new URL(server.url);
	const alpnProtocols = 'ALPNProtocols';

	await assert.rejects(got({
		http2: true,
		createConnection() {
			return tls.connect(Number(port), 'localhost', {
				[alpnProtocols]: ['h2', 'http/1.1'],
				rejectUnauthorized: false,
				servername: 'localhost',
			});
		},
		timeout: {
			socket: 500,
			request: 2500,
		},
		retry: {
			limit: 0,
		},
		https: {
			rejectUnauthorized: false,
		},
	}), errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'socket\' for 500ms'}));
});

test('http2 fallback does not use ALPN timeout as HTTP/1.1 socket timeout', withHttpsServer(), async (_t, server, got) => {
	server.get('/', async (_request, response) => {
		await delay(2000);
		response.end('ok');
	});

	const {body} = await got({
		http2: true,
		timeout: {
			lookup: 1000,
			request: 5000,
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, 'ok');
});

test('http2 with custom HTTPS agent does not use ALPN timeout as HTTP/1.1 socket timeout', withHttpsServer(), async (_t, server, got) => {
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
				// If this phase value were reused as the HTTP/1.1 socket timeout, the server delay
				// above would outlast it. The request budget only bounds a request that somehow
				// completes, so it sits far clear of both.
				lookup: 20,
				request: 10_000,
			},
			retry: {
				limit: 0,
			},
		});

		assert.strictEqual(body, 'ok');
	} finally {
		agent.destroy();
	}
});

test('http2 option on HTTP does not use ALPN timeout as socket timeout', withServer, async (_t, server, got) => {
	server.get('/', async (_request, response) => {
		await delay(120);
		response.end('ok');
	});

	const {body} = await got({
		http2: true,
		timeout: {
			// As above: the phase value is the discriminator, the request budget is not.
			secureConnect: 20,
			request: 10_000,
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, 'ok');
});

test('http2 ALPN negotiation treats zero request timeout as immediate', async _t => {
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
		const error = await rejects(got(`https://127.0.0.1:${port}`, {
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
		assert.strictEqual(error?.code, 'ETIMEDOUT');
		// A `request` timeout of `0` fires on the next tick, but it still has to travel through
		// the connection setup, so the bound only has to be well under the socket phase it would
		// otherwise wait for.
		assert.strictEqual(elapsed < 500, true, `Expected immediate timeout, got ${elapsed}ms`);
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

// The request budget covers the time an async `request` function spends, so the budget is armed
// before that function is called. A function that never settles makes that observable without a
// wall-clock assertion: if the budget were armed only once the function returned, nothing would
// ever time out. A promise that never settles holds no timer, so it cannot keep the loop alive.
const neverSettles = new Promise<never>(() => {});

test('request timeout includes async custom request function time', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	const error = await rejects(got({
		http2: true,
		timeout: {
			request: 500,
		},
		retry: {
			limit: 0,
		},
		async request() {
			await neverSettles;
			return http.request('', {}, () => {});
		},
	}));

	assert.strictEqual(error?.code, 'ETIMEDOUT');
});

test('request timeout includes async custom request fallback time', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	const error = await rejects(got({
		timeout: {
			request: 500,
		},
		retry: {
			limit: 0,
		},
		async request() {
			await neverSettles;
			return undefined;
		},
	}));

	assert.strictEqual(error?.code, 'ETIMEDOUT');
});

test('request timeout aborts slow async custom request function', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('too late');
	});

	const timeout = 500;
	const startTime = Date.now();
	const error = await rejects(got({
		http2: true,
		timeout: {
			request: timeout,
		},
		retry: {
			limit: 0,
		},
		async request() {
			// Far enough past the budget that the two outcomes cannot be confused.
			await delay(4000);
			return undefined;
		},
	}));

	const elapsed = Date.now() - startTime;
	assert.strictEqual(error?.code, 'ETIMEDOUT');
	assert.strictEqual(elapsed < 1500, true, `Expected timeout ${elapsed}ms to happen before custom request resolution`);
});

test('request timeout destroys late async custom request result', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('too late');
	});

	let lateRequest: http.ClientRequest | undefined;
	let resolveLateRequest!: () => void;
	const lateRequestCreated = new Promise<void>(resolve => {
		resolveLateRequest = resolve;
	});

	const error = await rejects(got({
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

	assert.strictEqual(error?.code, 'ETIMEDOUT');

	try {
		await lateRequestCreated;
		await delay(20);
		assert.strictEqual(lateRequest!.destroyed, true);
	} finally {
		lateRequest?.destroy();
	}
});

test('http2 custom request does not receive internal ALPN timeouts', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let requestTimeout: NativeRequestOptions['timeout'] | undefined;
	let hasSocketTimeout: boolean | undefined;
	const {body} = await got({
		http2: true,
		timeout: {
			request: 1000,
			socket: 1000,
		},
		retry: {
			limit: 0,
		},
		request(_url, options) {
			requestTimeout = options.timeout;
			hasSocketTimeout = Object.hasOwn(options, '_socketTimeout');
			return undefined;
		},
	});

	assert.strictEqual(body, 'ok');
	assert.strictEqual(requestTimeout, undefined);
	assert.strictEqual(hasSocketTimeout, false);
});

test('http2 custom request fallback retains the internal socket timeout', async _t => {
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

	let customRequestCalled = false;
	try {
		const {port} = server.address() as net.AddressInfo;
		const error = await rejects(got(`https://127.0.0.1:${port}`, {
			http2: true,
			timeout: {
				// As above: this only has to fire before the abort signal does.
				socket: 200,
			},
			signal: AbortSignal.timeout(3000),
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
			request(_url, options) {
				customRequestCalled = true;
				assert.strictEqual(Object.hasOwn(options, '_socketTimeout'), false);
				return undefined;
			},
		}), errorMatcher);

		assert.strictEqual(customRequestCalled, true);
		assert.strictEqual(error?.event, 'socket');
		assert.strictEqual(error?.message, 'Timeout awaiting \'socket\' for 200ms');
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

test('http2 async custom request fallback uses remaining request timeout for ALPN', async _t => {
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
		const error = await rejects(got(`https://127.0.0.1:${port}`, {
			http2: true,
			timeout: {
				request: 500,
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
			async request() {
				await neverSettles;
				return undefined;
			},
		}));

		assert.strictEqual(error?.code, 'ETIMEDOUT');
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

test('async custom request timeout is restored between retries', withServer, async (_t, server, got) => {
	let requestFunctionCalls = 0;
	let requests = 0;

	server.get('/', async (_request, response) => {
		requests++;

		// Both attempts make the server slow, so the budget is spent waiting for a response rather
		// than in a client-side delay. That keeps the two sides of the window this test measures
		// apart under load: each attempt has to fit inside a full budget on its own, and the pair
		// has to exceed one, so the retry only succeeds if the first attempt's budget was released.
		await delay(1000);

		if (requests === 1) {
			response.statusCode = 500;
			response.end('retry');
			return;
		}

		response.end('ok');
	});

	const {body, retryCount} = await got({
		http2: true,
		timeout: {
			request: 2000,
		},
		retry: {
			limit: 1,
			calculateDelay: ({computedValue}) => computedValue ? 1 : 0,
		},
		async request(url, options, callback) {
			requestFunctionCalls++;

			if (requestFunctionCalls === 1) {
				await delay(200);
			}

			return http.request(url, options, callback);
		},
	});

	assert.strictEqual(body, 'ok');
	assert.strictEqual(retryCount, 1);
	assert.strictEqual(requestFunctionCalls, 2);
});

// Reproduces the memory leak reported in https://github.com/sindresorhus/got/issues/2351
test.serial('no memory leak when using http2 with socket timeout and connection reuse', async _t => {
	const requestCount = 15; // Make concurrent requests to accumulate listeners
	let sharedSocket: any;
	let maxListenerCount = 0;
	const server = await createHttp2TestServer(async stream => {
		await delay(200);
		stream.respond({

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
			assert.strictEqual(request.isGotHttp2Request, true);
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

		assert.ok(sharedSocket, 'Should have a socket');
		assert.strictEqual(server.sessions.size, 1);

		// With the bug, timeout listeners grow with concurrent requests.
		assert.strictEqual(maxListenerCount <= 2, true, `Socket peaked at ${maxListenerCount} timeout listeners (expected ≤ 2)`);
	} finally {
		await server.close();
	}
});

test('request timeout spans redirects', withServer, async (_t, server, got) => {
	server.get('/redirect', async (_request, response) => {
		await delay(300);
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', async (_request, response) => {
		await delay(300);
		response.end('ok');
	});

	const error = await rejects(got('redirect', {
		timeout: {
			request: 400,
		},
		retry: {
			limit: 0,
		},
	}), errorMatcher);

	assert.strictEqual(error?.event, 'request');
});

test.serial('request timeout starts after initial request setup', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let beforeRequestCalls = 0;

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		server.get('/final', (_request, response) => {
			response.end('ok');
		});

		const {body} = await got('redirect', {
			hooks: {
				beforeRequest: [async () => {
					beforeRequestCalls++;

					if (beforeRequestCalls === 1) {
						clock.tick(200);
						await Promise.resolve();
					}
				}],
			},
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
		});

		assert.strictEqual(body, 'ok');
		assert.strictEqual(beforeRequestCalls, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('request timeout includes redirected HTTP/2 setup', withServer, async (_t, server, got) => {
	const sockets = new Set<net.Socket>();
	const destinationServer = net.createServer(socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>(resolve => {
		destinationServer.listen(0, '127.0.0.1', resolve);
	});

	const clock = FakeTimers.install({
		toFake: ['Date'],
	});

	try {
		const {port} = destinationServer.address() as net.AddressInfo;
		server.get('/redirect', (_request, response) => {
			clock.tick(300);
			response.writeHead(302, {
				location: `https://127.0.0.1:${port}`,
			});
			response.end();
		});

		const error = await rejects(got('redirect', {
			http2: true,
			timeout: {
				request: 400,
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		}), errorMatcher);

		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(error?.message, 'Timeout awaiting \'request\' for 400ms');
	} finally {
		clock.uninstall();

		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			destinationServer.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test.serial('request timeout includes redirected async custom request function time', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let requestFunctionCalls = 0;

	try {
		server.get('/redirect', (_request, response) => {
			clock.tick(300);
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		const error = await rejects(got('redirect', {
			timeout: {
				request: 400,
			},
			retry: {
				limit: 0,
			},
			async request(url, options, callback) {
				requestFunctionCalls++;

				return requestFunctionCalls === 1 ? http.request(url, options, callback) : new Promise<never>(() => {});
			},
		}), errorMatcher);

		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(error?.message, 'Timeout awaiting \'request\' for 400ms');
		assert.strictEqual(requestFunctionCalls, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('request timeout rejects before starting a redirect after beforeRedirect exhausts the budget', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let requestFunctionCalls = 0;
	let finishHook!: () => void;
	const hookMayFinish = new Promise<void>(resolve => {
		finishHook = resolve;
	});

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		const error = await rejects(got('redirect', {
			hooks: {
				beforeRedirect: [
					async () => {
						clock.tick(100);
						await hookMayFinish;
						throw new Error('late hook failure');
					},
				],
			},
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
			request(url, options, callback) {
				requestFunctionCalls++;

				return requestFunctionCalls === 1 ? http.request(url, options, callback) : new Promise<never>(() => {});
			},
		}), errorMatcher);

		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(requestFunctionCalls, 1);
		finishHook();
		await delay(20);
	} finally {
		finishHook();
		clock.uninstall();
	}
});

test.serial('expired redirect budget does not invoke beforeRedirect hooks', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let hookCalls = 0;

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		await assert.rejects(got('redirect', {
			followRedirect() {
				clock.tick(100);
				return true;
			},
			hooks: {
				beforeRedirect: [
					() => {
						hookCalls++;
					},
				],
			},
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		assert.strictEqual(hookCalls, 0);
	} finally {
		clock.uninstall();
	}
});

test.serial('expired redirect budget does not invoke later beforeRedirect hooks', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let secondHookCalls = 0;

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		await assert.rejects(got('redirect', {
			hooks: {
				beforeRedirect: [
					async options => {
						options.timeout.request = undefined;
						await Promise.resolve();
						options.timeout.request = 100;
						clock.tick(100);
					},
					() => {
						secondHookCalls++;
					},
				],
			},
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		assert.strictEqual(secondHookCalls, 0);
	} finally {
		clock.uninstall();
	}
});

test.serial('expired redirect budget does not invoke redirected beforeRequest hooks', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let hookCalls = 0;

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		await assert.rejects(got('redirect', {
			followRedirect() {
				clock.tick(100);
				return true;
			},
			headers: {
				cookie: undefined,
			},
			hooks: {
				beforeRequest: [
					() => {
						hookCalls++;
					},
				],
			},
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		assert.strictEqual(hookCalls, 1);
	} finally {
		clock.uninstall();
	}
});

test.serial('expired redirect budget does not invoke redirected cookie lookup', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let cookieLookupCalls = 0;

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		await assert.rejects(got('redirect', {
			cookieJar: {
				async getCookieString() {
					cookieLookupCalls++;
					return '';
				},
				async setCookie() {},
			},
			followRedirect() {
				clock.tick(100);
				return true;
			},
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
		}), errorMatcher);

		assert.strictEqual(cookieLookupCalls, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('beforeRedirect can increase the request timeout for the redirected request', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', async (_request, response) => {
		await delay(150);
		response.end('ok');
	});

	const response = await got('redirect', {
		hooks: {
			beforeRedirect: [
				options => {
					options.timeout.request = 500;
				},
			],
		},
		timeout: {
			request: 100,
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(response.body, 'ok');
});

test.serial('request timeout interrupts a pending beforeRedirect hook', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	const controller = new AbortController();
	let hookEntered!: () => void;
	const hookEnteredPromise = new Promise<void>(resolve => {
		hookEntered = resolve;
	});
	let finishHook!: () => void;
	const hookMayFinish = new Promise<void>(resolve => {
		finishHook = resolve;
	});
	let requestFunctionCalls = 0;
	let secondHookCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		hooks: {
			beforeRedirect: [
				async () => {
					hookEntered();
					await hookMayFinish;
				},
				async () => {
					secondHookCalls++;
				},
			],
		},
		timeout: {
			request: 1000,
		},
		retry: {
			limit: 0,
		},
		request(url, options, callback) {
			requestFunctionCalls++;
			return http.request(url, options, callback);
		},
	});
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	try {
		const errorPromise = rejects(Promise.race([
			request,
			new Promise<never>((_resolve, reject) => {
				watchdog = setTimeout(() => {
					reject(new Error('Request did not time out while awaiting beforeRedirect'));
				}, 10_000);
			}),
		]));
		const waitForHookEntry = async () => {
			await hookEnteredPromise;
			return true;
		};

		const waitForTimeout = async () => {
			await errorPromise;
			return false;
		};

		const hookWasEntered = await Promise.race([
			waitForHookEntry(),
			waitForTimeout(),
		]);
		assert.strictEqual(hookWasEntered, true);
		const error = await errorPromise;

		assert.strictEqual(error instanceof TimeoutError, true);
		assert.strictEqual(error.event, 'request');
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(secondHookCalls, 0);

		finishHook();
		await delay(20);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(secondHookCalls, 0);
	} finally {
		finishHook();
		clearTimeout(watchdog);
		controller.abort();
	}
});

test.serial('aborting during a pending beforeRedirect hook does not start the redirect', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	const controller = new AbortController();
	let hookEntered!: () => void;
	const hookEnteredPromise = new Promise<void>(resolve => {
		hookEntered = resolve;
	});
	let finishHook!: () => void;
	const hookMayFinish = new Promise<void>(resolve => {
		finishHook = resolve;
	});
	let requestFunctionCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		hooks: {
			beforeRedirect: [
				async () => {
					hookEntered();
					await hookMayFinish;
				},
			],
		},
		timeout: {
			request: 10_000,
		},
		retry: {
			limit: 0,
		},
		request(url, options, callback) {
			requestFunctionCalls++;
			return http.request(url, options, callback);
		},
	});

	try {
		await hookEnteredPromise;
		controller.abort();
		await assert.rejects(request, {message: 'This operation was aborted.'});

		finishHook();
		await delay(20);
		assert.strictEqual(requestFunctionCalls, 1);
	} finally {
		finishHook();
		controller.abort();
	}
});

test.serial('request timeout interrupts redirected beforeRequest setup', withServer, async (_t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('ok');
	});

	const controller = new AbortController();
	let redirectedHookEntered!: () => void;
	const redirectedHookEnteredPromise = new Promise<void>(resolve => {
		redirectedHookEntered = resolve;
	});
	let finishHook!: () => void;
	const hookMayFinish = new Promise<void>(resolve => {
		finishHook = resolve;
	});
	let hookCalls = 0;
	let secondHookCalls = 0;
	let requestFunctionCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		hooks: {
			beforeRequest: [
				async () => {
					hookCalls++;

					if (hookCalls === 2) {
						redirectedHookEntered();
						await hookMayFinish;
						throw new Error('late hook failure');
					}
				},
				async () => {
					secondHookCalls++;
				},
			],
		},
		timeout: {
			request: 100,
		},
		retry: {
			limit: 0,
		},
		request(url, options, callback) {
			requestFunctionCalls++;
			return http.request(url, options, callback);
		},
	});
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	try {
		const errorPromise = rejects(Promise.race([
			request,
			new Promise<never>((_resolve, reject) => {
				watchdog = setTimeout(() => {
					reject(new Error('Request did not time out during redirected beforeRequest setup'));
				}, 1000);
			}),
		]), errorMatcher);

		await redirectedHookEnteredPromise;
		const error = await errorPromise;
		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(hookCalls, 2);
		assert.strictEqual(secondHookCalls, 1);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);

		finishHook();
		await delay(20);
		assert.strictEqual(secondHookCalls, 1);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);
	} finally {
		finishHook();
		clearTimeout(watchdog);
		controller.abort();
	}
});

test.serial('redirected beforeRequest can disable the request timeout before awaiting', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', (_request, response) => {
		response.end('ok');
	});

	let hookCalls = 0;
	const response = await got('redirect', {
		hooks: {
			beforeRequest: [
				async options => {
					hookCalls++;

					if (hookCalls === 2) {
						options.timeout.request = undefined;
						await delay(150);
					}
				},
			],
		},
		timeout: {
			request: 100,
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(response.body, 'ok');
	assert.strictEqual(hookCalls, 2);
});

test.serial('aborting during redirected beforeRequest setup does not start the request', withServer, async (_t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('ok');
	});

	const controller = new AbortController();
	let redirectedHookEntered!: () => void;
	const redirectedHookEnteredPromise = new Promise<void>(resolve => {
		redirectedHookEntered = resolve;
	});
	let finishHook!: () => void;
	const hookMayFinish = new Promise<void>(resolve => {
		finishHook = resolve;
	});
	let hookCalls = 0;
	let requestFunctionCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		hooks: {
			beforeRequest: [
				async () => {
					hookCalls++;

					if (hookCalls === 2) {
						redirectedHookEntered();
						await hookMayFinish;
					}
				},
			],
		},
		retry: {
			limit: 0,
		},
		request(url, options, callback) {
			requestFunctionCalls++;
			return http.request(url, options, callback);
		},
	});

	try {
		await redirectedHookEnteredPromise;
		controller.abort();
		await assert.rejects(request, {message: 'This operation was aborted.'});

		finishHook();
		await delay(20);
		assert.strictEqual(hookCalls, 2);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);
	} finally {
		finishHook();
		controller.abort();
	}
});

test.serial('aborting during redirected async request setup does not send the request', withServer, async (_t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('ok');
	});

	const controller = new AbortController();
	let redirectedRequestEntered!: () => void;
	const redirectedRequestEnteredPromise = new Promise<void>(resolve => {
		redirectedRequestEntered = resolve;
	});
	let finishRequest!: () => void;
	const requestMayFinish = new Promise<void>(resolve => {
		finishRequest = resolve;
	});
	let requestFunctionCalls = 0;
	let redirectedRequest: http.ClientRequest | undefined;
	const request = got('redirect', {
		signal: controller.signal,
		retry: {
			limit: 0,
		},
		async request(url, options, callback) {
			requestFunctionCalls++;

			if (requestFunctionCalls === 2) {
				redirectedRequestEntered();
				await requestMayFinish;
				redirectedRequest = http.request(url, options, callback);
				return redirectedRequest;
			}

			return http.request(url, options, callback);
		},
	});

	try {
		await redirectedRequestEnteredPromise;
		controller.abort();
		await assert.rejects(request, {message: 'This operation was aborted.'});

		finishRequest();
		await delay(20);
		assert.strictEqual(requestFunctionCalls, 2);
		assert.strictEqual(redirectedRequest?.destroyed, true);
		assert.strictEqual(finalRequests, 0);
	} finally {
		finishRequest();
		controller.abort();
	}
});

test.serial('request timeout interrupts redirected cookie setup', withServer, async (_t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('ok');
	});

	const controller = new AbortController();
	let redirectedCookieLookupEntered!: () => void;
	const redirectedCookieLookupEnteredPromise = new Promise<void>(resolve => {
		redirectedCookieLookupEntered = resolve;
	});
	let finishCookieLookup!: () => void;
	const cookieLookupMayFinish = new Promise<void>(resolve => {
		finishCookieLookup = resolve;
	});
	let requestFunctionCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		cookieJar: {
			async getCookieString(url: string) {
				if (new URL(url).pathname === '/final') {
					redirectedCookieLookupEntered();
					await cookieLookupMayFinish;
					throw new Error('late cookie lookup failure');
				}

				return '';
			},
			async setCookie() {},
		},
		timeout: {
			request: 100,
		},
		retry: {
			limit: 0,
		},
		request(url, options, callback) {
			requestFunctionCalls++;
			return http.request(url, options, callback);
		},
	});
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	try {
		const errorPromise = rejects(Promise.race([
			request,
			new Promise<never>((_resolve, reject) => {
				watchdog = setTimeout(() => {
					reject(new Error('Request did not time out during redirected cookie setup'));
				}, 1000);
			}),
		]), errorMatcher);

		await redirectedCookieLookupEnteredPromise;
		const error = await errorPromise;
		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);

		finishCookieLookup();
		await delay(20);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);
	} finally {
		finishCookieLookup();
		clearTimeout(watchdog);
		controller.abort();
	}
});

test.serial('request timeout prevents redirected beforeRequest hooks after cookie setup', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {location: '/final'});
		response.end();
	});
	server.get('/final', (_request, response) => {
		response.end('ok');
	});

	const redirectedCookieLookupEntered = Promise.withResolvers<void>();
	const cookieLookupMayFinish = Promise.withResolvers<void>();
	const cookieLookupFinished = Promise.withResolvers<void>();
	const controller = new AbortController();
	let redirectedBeforeRequestCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		cookieJar: {
			async getCookieString(url: string) {
				if (new URL(url).pathname === '/final') {
					redirectedCookieLookupEntered.resolve();
					await cookieLookupMayFinish.promise;
					cookieLookupFinished.resolve();
				}

				return '';
			},
			async setCookie() {},
		},
		hooks: {
			beforeRequest: [options => {
				if (options.url?.pathname === '/final') {
					redirectedBeforeRequestCalls++;
				}
			}],
		},
		timeout: {
			request: 100,
		},
		retry: {
			limit: 0,
		},
	});

	try {
		const error = await Promise.all([
			redirectedCookieLookupEntered.promise,
			rejects(request, errorMatcher),
		]);
		assert.strictEqual(error[1]?.event, 'request');

		cookieLookupMayFinish.resolve();
		// Wait until the jar has actually returned, so the grace period below only covers what
		// Got does next rather than how long the machine took to get there.
		await cookieLookupFinished.promise;
		await delay(20);
		assert.strictEqual(redirectedBeforeRequestCalls, 0);
	} finally {
		cookieLookupMayFinish.resolve();
		controller.abort();
	}
});

test.serial('request timeout interrupts redirected cache setup', withServer, async (_t, server, got) => {
	let finalRequests = 0;
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});
	server.get('/final', (_request, response) => {
		finalRequests++;
		response.end('ok');
	});

	const controller = new AbortController();
	let redirectedCacheLookupEntered!: () => void;
	const redirectedCacheLookupEnteredPromise = new Promise<void>(resolve => {
		redirectedCacheLookupEntered = resolve;
	});
	let finishCacheLookup!: () => void;
	const cacheLookupMayFinish = new Promise<void>(resolve => {
		finishCacheLookup = resolve;
	});
	const cache = new Map();
	const getFromCache = cache.get.bind(cache);
	let cacheGetCalls = 0;
	cache.get = key => {
		cacheGetCalls++;

		if (cacheGetCalls === 2) {
			redirectedCacheLookupEntered();
			return (async () => {
				await cacheLookupMayFinish;
				return undefined;
			})();
		}

		return getFromCache(key);
	};

	let requestFunctionCalls = 0;
	const request = got('redirect', {
		signal: controller.signal,
		cache,
		timeout: {
			request: 100,
		},
		retry: {
			limit: 0,
		},
		request(url, options, callback) {
			requestFunctionCalls++;
			return http.request(url, options, callback);
		},
	});
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	try {
		const errorPromise = rejects(Promise.race([
			request,
			new Promise<never>((_resolve, reject) => {
				watchdog = setTimeout(() => {
					reject(new Error('Request did not time out during redirected cache setup'));
				}, 1000);
			}),
		]), errorMatcher);

		await redirectedCacheLookupEnteredPromise;
		const error = await errorPromise;
		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(cacheGetCalls, 2);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);

		finishCacheLookup();
		await delay(20);
		assert.strictEqual(requestFunctionCalls, 1);
		assert.strictEqual(finalRequests, 0);
	} finally {
		finishCacheLookup();
		clearTimeout(watchdog);
		controller.abort();
	}
});

test.serial('request timeout destroys a redirected async custom request result after the global budget expires', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});
	let requestFunctionCalls = 0;
	let redirectedRequest: http.ClientRequest | undefined;

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		server.get('/final', () => {});

		const error = await rejects(got('redirect', {
			timeout: {
				request: 100,
			},
			retry: {
				limit: 0,
			},
			async request(url, options, callback) {
				requestFunctionCalls++;

				if (requestFunctionCalls === 1) {
					return http.request(url, options, callback);
				}

				redirectedRequest = http.request(url, options, callback);
				redirectedRequest.on('error', () => {});
				clock.tick(100);
				await Promise.resolve();
				return redirectedRequest;
			},
		}), errorMatcher);

		assert.strictEqual(error?.event, 'request');
		assert.strictEqual(redirectedRequest!.destroyed, true);
	} finally {
		redirectedRequest?.destroy();
		clock.uninstall();
	}
});

test.serial('request timeout does not double count async custom request function time on redirects', withServer, async (_t, server, got) => {
	const clock = FakeTimers.install({
		toFake: ['Date'],
	});

	try {
		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: '/final',
			});
			response.end();
		});

		server.get('/final', (_request, response) => {
			response.end('ok');
		});

		const {body} = await got('redirect', {
			timeout: {
				request: 5000,
			},
			retry: {
				limit: 0,
			},
			async request(url, options, callback) {
				clock.tick(2000);
				await Promise.resolve();
				return http.request(url, options, callback);
			},
		});

		assert.strictEqual(body, 'ok');
	} finally {
		clock.uninstall();
	}
});

test('response timeout does not restart when headers arrive before upload completion', withServer, async (_t, server, got) => {
	server.post('/', async (incoming, response) => {
		response.flushHeaders();
		await getStream(incoming);
		await delay(150);
		response.end('done');
	});

	const request = got.stream.post('', {
		timeout: {response: 50, request: 1000},
		retry: {limit: 0},
	});
	const body = getStream(request);
	request.on('request', nativeRequest => {
		nativeRequest.once('response', () => {
			request.end('last');
		});
	});
	request.write('first');

	assert.strictEqual(await body, 'done');
});

test('early response headers still start the read timeout', withServer, async (_t, server, got) => {
	server.post('/', (incoming, response) => {
		// The headers arrive immediately and nothing ever follows them, so only the read timeout
		// can end this request. A delayed body would instead race the destroy that the timeout
		// defers by a tick, which a busy event loop can schedule after the body.
		response.flushHeaders();
		incoming.resume();
	});

	const request = got.stream.post('', {
		// The upload finishes after the headers, so the response timeout is armed and then has to
		// be given up for the read one. If the read timeout did not take over when the headers
		// arrived, this is the value that would end the request instead.
		timeout: {response: 400, read: 50, request: 10_000},
		retry: {limit: 0},
	});
	const body = getStream(request);
	request.on('request', nativeRequest => {
		nativeRequest.once('response', () => {
			request.end('last');
		});
	});
	request.write('first');

	const error = await rejects(body, errorMatcher);
	assert.strictEqual(error?.event, 'read');
});

test('canceling timeouts removes pending response timeout listeners', _t => {
	const request = new EventEmitter();
	const cancel = timedOut(request as http.ClientRequest, {response: 100}, {});
	cancel();

	assert.strictEqual(request.listenerCount('upload-complete'), 0);
	assert.strictEqual(request.listenerCount('response'), 0);
});

test('send timeout applies when an async request factory returns after socket assignment', withServer, async (_t, server, got) => {
	server.post('/', request => {
		request.resume();
	});
	const body = new stream.PassThrough();

	const error = await rejects(got.post('', {
		body,
		retry: {limit: 0},
		timeout: {send: 20, request: 10_000},
		async request(url, options) {
			const request = http.request(url, options);
			await once(request, 'socket');
			return request;
		},
	}), TimeoutError);

	assert.strictEqual(error.event, 'send');
});

test('send timeout applies when the factory returns an already connected request', withServer, async (_t, server, got) => {
	server.post('/', request => {
		request.resume();
	});

	const error = await rejects(got.post('', {
		body: new stream.PassThrough(),
		retry: {limit: 0},
		timeout: {send: 20, request: 10_000},
		async request(url, options) {
			const request = http.request(url, options);
			const [socket] = await once(request, 'socket');
			if (socket.connecting) {
				await once(socket, 'connect');
			}

			return request;
		},
	}), TimeoutError);

	assert.strictEqual(error.event, 'send');
});

test('send timeout applies to an already assigned keep-alive socket', withServer, async (t, server, got) => {
	server.get('/prime', (_request, response) => {
		response.end('ready');
	});
	server.post('/', request => {
		request.resume();
	});
	const agent = new http.Agent({keepAlive: true});
	t.after(() => {
		agent.destroy();
	});
	await got('prime', {agent: {http: agent}});

	const error = await rejects(got.post('', {
		agent: {http: agent},
		body: new stream.PassThrough(),
		retry: {limit: 0},
		timeout: {send: 20, request: 10_000},
		async request(url, options) {
			const request = http.request(url, options);
			const [socket] = await once(request, 'socket');
			assert.strictEqual(socket.connecting, false);
			assert.strictEqual(request.reusedSocket, true);
			return request;
		},
	}), TimeoutError);

	assert.strictEqual(error.event, 'send');
});

test('completed uploads cancel the send timeout on already assigned sockets', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		const body = await getStream(request);
		await delay(60);
		response.end(body);
	});

	assert.strictEqual(await got.post('', {
		body: 'payload',
		retry: {limit: 0},
		timeout: {send: 20, request: 10_000},
		async request(url, options) {
			const request = http.request(url, options);
			await once(request, 'socket');
			return request;
		},
	}).text(), 'payload');
});

test.serial('connect timeout starts when synchronous DNS has already completed', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
	let connectingAtAssignment: boolean | undefined;
	let addressAtAssignment: string | undefined;

	try {
		const request = got({
			agent: {http: false},
			dnsLookupIpVersion: 4,
			timeout: {connect: 10},
			retry: {limit: 0},
			dnsLookup(_hostname, _options, callback) {
				callback(null, '127.0.0.1', 4);
			},
		}).on('request', request => {
			request.once('socket', socket => {
				connectingAtAssignment = socket.connecting;
				addressAtAssignment = (socket.address() as net.AddressInfo).address;
				// Advance the connection budget before the native connect event can arrive.
				clock.tick(11);
			});
		});

		await assert.rejects(request.text(), errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'connect\' for 10ms'}));
		assert.strictEqual(connectingAtAssignment, true);
		assert.strictEqual(addressAtAssignment, '127.0.0.1');
	} finally {
		clock.uninstall();
	}
});

for (const afterLookup of [false, true]) {
	test.serial(`connect timeout ${afterLookup ? 'starts after' : 'excludes time spent in'} asynchronous DNS`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('ok');
		});
		const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
		let lookedUp = false;
		let lookedUpAtAssignment: boolean | undefined;

		try {
			const request = got({
				agent: {http: false},
				dnsLookupIpVersion: 4,
				timeout: {connect: 10},
				retry: {limit: 0},
				dnsLookup(_hostname, _options, callback) {
					setImmediate(() => {
						lookedUp = true;
						callback(null, '127.0.0.1', 4);
					});
				},
			}).on('request', request => {
				request.once('socket', socket => {
					lookedUpAtAssignment = lookedUp;
					if (afterLookup) {
						socket.once('lookup', () => {
							clock.tick(11);
						});
					} else {
						clock.tick(11);
					}
				});
			});

			if (afterLookup) {
				await assert.rejects(request.text(), errorMatching(TimeoutError, {code: 'ETIMEDOUT', message: 'Timeout awaiting \'connect\' for 10ms'}));
			} else {
				assert.strictEqual(await request.text(), 'ok');
			}

			assert.strictEqual(lookedUpAtAssignment, false);
			assert.strictEqual(lookedUp, true);
		} finally {
			clock.uninstall();
		}
	});
}

test.serial('connection completion cancels the timeout after synchronous DNS', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
	let connected = false;

	try {
		const body = await got({
			agent: {http: false},
			dnsLookupIpVersion: 4,
			timeout: {connect: 10},
			retry: {limit: 0},
			dnsLookup(_hostname, _options, callback) {
				callback(null, '127.0.0.1', 4);
			},
		}).on('request', request => {
			request.once('socket', socket => {
				socket.once('connect', () => {
					connected = true;
					clock.tick(11);
				});
			});
		}).text();

		assert.strictEqual(body, 'ok');
		assert.strictEqual(connected, true);
	} finally {
		clock.uninstall();
	}
});

test.serial('connect timeout does not start again for a reused connected socket', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	const agent = new http.Agent({keepAlive: true});
	t.after(() => {
		agent.destroy();
	});
	const client = got.extend({agent: {http: agent}, retry: {limit: 0}});
	await client('');
	const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
	let reusedSocket: boolean | undefined;
	let connectingAtAssignment: boolean | undefined;

	try {
		const body = await client('', {timeout: {connect: 10}}).on('request', request => {
			request.once('socket', socket => {
				reusedSocket = request.reusedSocket;
				connectingAtAssignment = socket.connecting;
				clock.tick(11);
			});
		}).text();

		assert.strictEqual(body, 'ok');
		assert.strictEqual(reusedSocket, true);
		assert.strictEqual(connectingAtAssignment, false);
	} finally {
		clock.uninstall();
	}
});

test('response timeout starts after a bodyless redirected request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await rejects(got('', {
		timeout: {response: 30, request: 10_000},
		retry: {limit: 0},
	}), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

test('response timeout starts after a 303 redirect that drops the body', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.redirect(303, '/slow');
	});
	server.get('/slow', () => {});

	const error = await rejects(got.post('', {
		body: 'payload',
		timeout: {response: 30, request: 10_000},
		retry: {limit: 0},
	}), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

test('response timeout starts after a HEAD redirect', withServer, async (_t, server, got) => {
	server.head('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.head('/slow', () => {});

	const error = await rejects(got.head('', {
		timeout: {response: 30, request: 10_000},
		retry: {limit: 0},
	}), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

test('fast redirected responses are unaffected by the response timeout', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/fast');
	});
	server.get('/fast', (_request, response) => {
		response.end('ok');
	});

	const response = await got('', {timeout: {response: 500}});
	assert.strictEqual(response.body, 'ok');
});

test('response timeout works without a request timeout on redirects', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await rejects(got('', {
		timeout: {response: 30},
		retry: {limit: 0},
	}), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

test('a stream client gets the response timeout error after a redirect', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await rejects(got.stream('', {
		timeout: {response: 30, request: 10_000},
		retry: {limit: 0},
	}).toArray(), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

test('redirect response timeout still applies through multiple hops', withServer, async (_t, server, got) => {
	server.get('/a', (_request, response) => {
		response.redirect('/b');
	});
	server.get('/b', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await rejects(got('a', {
		timeout: {response: 30, request: 10_000},
		retry: {limit: 0},
	}), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

test('regression: normal redirected requests complete without timeouts', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/final');
	});
	server.get('/final', (_request, response) => {
		response.end('done');
	});

	const response = await got('', {timeout: {response: 2000, request: 2000}});
	assert.strictEqual(response.body, 'done');
	assert.strictEqual(response.url, `${server.url}/final`);
});

// The `socket` timeout is the inactivity timeout, so it has to cover a stalled response body
// and not only the connection setup.
test('http2 socket timeout applies to a stalled response body', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.write('partial');
		// The body never ends.
	});
	t.after(async () => {
		await server.close();
	});

	const error = await rejects(got(server.url, {
		http2: true,
		https: {
			rejectUnauthorized: false,
		},
		retry: {
			limit: 0,
		},
		timeout: {
			socket: 300,
		},
	}), errorMatcher);

	assert.strictEqual(error?.event, 'socket');
	assert.match(error?.message ?? '', /^Timeout awaiting 'socket' for 300ms$/v);
});

// Node.js collapses timer delays above the 32-bit limit to 1 ms, so such delays, including
// `Infinity`, must mean "no timeout" rather than an instant timeout.
test('delays above the Node.js timer limit are not armed as timeouts', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const response = await got(server.url, {
		timeout: {
			request: Infinity,
			response: Infinity,
			connect: Infinity,
			send: Infinity,
			socket: Infinity,
		},
		retry: {limit: 0},
	});

	assert.strictEqual(response.body, 'ok');
});

test('a read delay above the Node.js timer limit does not abort the body', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {'transfer-encoding': 'chunked'});
		response.write('part');
		setTimeout(() => {
			response.end(' done');
		}, 50);
	});

	const response = await got(server.url, {
		timeout: {read: Infinity},
		retry: {limit: 0},
	});

	assert.strictEqual(response.body, 'part done');
});

test('every attempt gets its own phase timeout until the retries run out', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', () => {
		requests++;
	});

	const events: string[] = [];
	const error = await rejects<TimeoutError>(got('', {
		timeout: {response: 100},
		retry: {limit: 2, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [
				error => {
					events.push(`${error.code} ${(error as TimeoutError).event}`);
				},
			],
		},
	}), errorMatching(TimeoutError, {code: 'ETIMEDOUT', event: 'response', message: 'Timeout awaiting \'response\' for 100ms'}));

	assert.strictEqual(requests, 3);
	assert.strictEqual(error.request.retryCount, 2);
	assert.deepStrictEqual(events, ['ETIMEDOUT response', 'ETIMEDOUT response']);
});

test('a timeout is not retried when ETIMEDOUT is not in errorCodes', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', () => {
		requests++;
	});

	await rejects(got('', {
		timeout: {response: 100},
		retry: {
			limit: 2,
			errorCodes: ['ECONNRESET'],
			backoffLimit: 0,
			noise: 0,
		},
	}), errorMatching(TimeoutError, {event: 'response'}));

	assert.strictEqual(requests, 1);
});

test('a Got stream retries a timeout with createRetryStream', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		if (requests > 1) {
			response.end('recovered');
		}
	});

	const retries: Array<[number, string]> = [];
	const body = await new Promise<string>((resolve, reject) => {
		const run = (stream: ReturnType<typeof got.stream>) => {
			const chunks: Uint8Array[] = [];
			stream.on('data', (chunk: Uint8Array) => {
				chunks.push(chunk);
			});
			stream.once('retry', (retryCount, error, createRetryStream) => {
				retries.push([retryCount, (error as TimeoutError).event]);
				run(createRetryStream());
			});
			stream.once('end', () => {
				resolve(Buffer.concat(chunks).toString());
			});
			stream.once('error', reject);
		};

		run(got.stream('', {timeout: {response: 100}, retry: {limit: 1, backoffLimit: 0, noise: 0}}));
	});

	assert.strictEqual(body, 'recovered');
	assert.strictEqual(requests, 2);
	assert.deepStrictEqual(retries, [[1, 'response']]);
});

test('a stalled compressed body triggers the read timeout', withServer, async (_t, server, got) => {
	const compressed = zlib.gzipSync('a'.repeat(10_000));
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-encoding': 'gzip', 'content-length': String(compressed.length)});
		response.write(compressed.subarray(0, compressed.length / 2));
	});

	await rejects(got('', {timeout: {read: 100}, retry: {limit: 0}}), errorMatching(TimeoutError, {code: 'ETIMEDOUT', event: 'read'}));
});
