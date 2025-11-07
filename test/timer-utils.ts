import {EventEmitter} from 'node:events';
import test from 'ava';
import timer from '../source/core/utils/timer.js';

// Helper for delays
const delay = async (ms: number) => new Promise(resolve => {
	setTimeout(resolve, ms);
});

// Helper to create a mock request
function createMockRequest() {
	const request = new EventEmitter() as any;
	request.prependOnceListener = request.once.bind(request);
	request.off = request.removeListener.bind(request);
	request.writableFinished = false;
	return request;
}

// Helper to create a mock socket
function createMockSocket(options: {connecting?: boolean; writable?: boolean; destroyed?: boolean} = {}) {
	const socket = new EventEmitter() as any;
	socket.prependOnceListener = socket.once.bind(socket);
	socket.connecting = options.connecting ?? false;
	socket.writable = options.writable ?? true;
	socket.destroyed = options.destroyed ?? false;
	socket.removeListener = socket.off.bind(socket);
	return socket;
}

// Helper to create a mock response
function createMockResponse() {
	const response = new EventEmitter() as any;
	response.prependOnceListener = response.once.bind(response);
	response.off = response.removeListener.bind(response);
	return response;
}

test('timer returns same object on subsequent calls (singleton)', t => {
	const request = createMockRequest();
	const timings1 = timer(request);
	const timings2 = timer(request);

	t.is(timings1, timings2, 'should return the same timings object');
});

test('timer initializes all properties to undefined except start', t => {
	const request = createMockRequest();
	const timings = timer(request);

	t.is(typeof timings.start, 'number');
	t.is(timings.socket, undefined);
	t.is(timings.lookup, undefined);
	t.is(timings.connect, undefined);
	t.is(timings.secureConnect, undefined);
	t.is(timings.upload, undefined);
	t.is(timings.response, undefined);
	t.is(timings.end, undefined);
	t.is(timings.error, undefined);
	t.is(timings.abort, undefined);

	t.is(timings.phases.wait, undefined);
	t.is(timings.phases.dns, undefined);
	t.is(timings.phases.tcp, undefined);
	t.is(timings.phases.tls, undefined);
	t.is(timings.phases.request, undefined);
	t.is(timings.phases.firstByte, undefined);
	t.is(timings.phases.download, undefined);
	t.is(timings.phases.total, undefined);
});

test('timer sets socket timing when socket event fires', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);

	t.is(typeof timings.socket, 'number');
	t.is(typeof timings.phases.wait, 'number');
	t.true(timings.phases.wait! >= 0);
});

test('timer handles already attached socket', t => {
	const request = createMockRequest();
	const socket = createMockSocket({connecting: true});
	request.socket = socket;

	const timings = timer(request);

	t.is(typeof timings.socket, 'number');
	t.is(typeof timings.phases.wait, 'number');
});

test('timer measures DNS lookup timing', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	await delay(10);
	socket.emit('lookup');
	await delay(5);
	socket.emit('connect');

	t.is(typeof timings.lookup, 'number');
	t.is(typeof timings.phases.dns, 'number');
	t.true(timings.phases.dns! > 0);
	t.is(timings.phases.dns, timings.lookup! - timings.socket!);
});

test('timer handles IP address connection (no DNS lookup)', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	// Emit connect without lookup (simulates IP address connection)
	socket.emit('connect');

	t.is(timings.lookup, timings.socket);
	t.is(timings.phases.dns, 0);
	t.is(typeof timings.connect, 'number');
});

test('timer measures TCP connection timing', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('lookup');
	await delay(10);
	socket.emit('connect');

	t.is(typeof timings.connect, 'number');
	t.is(typeof timings.phases.tcp, 'number');
	t.true(timings.phases.tcp! >= 0);
	t.is(timings.phases.tcp, timings.connect! - timings.lookup!);
});

test('timer measures TLS handshake timing', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	socket.encrypted = true; // Mark as TLS socket
	socket.authorized = false;

	request.emit('socket', socket);
	socket.emit('lookup');
	socket.emit('connect');
	await delay(10);
	socket.emit('secureConnect');

	t.is(typeof timings.secureConnect, 'number');
	t.is(typeof timings.phases.tls, 'number');
	t.true(timings.phases.tls! > 0);
	t.is(timings.phases.tls, timings.secureConnect! - timings.connect!);
});

test('timer handles socket reuse with stored timings', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({writable: true, connecting: false});

	// Simulate stored timings from previous request
	socket.__initial_connection_timings__ = {
		dnsPhase: 5,
		tcpPhase: 10,
		tlsPhase: 15,
	};

	request.emit('socket', socket);

	// Verify phases are restored from initial connection
	t.is(timings.phases.dns, 5);
	t.is(timings.phases.tcp, 10);
	t.is(timings.phases.tls, 15);

	// Verify all timestamps are at socket time (no new connection for THIS request)
	t.is(timings.lookup, timings.socket);
	t.is(timings.connect, timings.socket);
	t.is(timings.secureConnect, timings.socket);
});

test('timer handles socket reuse without TLS', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({writable: true, connecting: false});

	socket.__initial_connection_timings__ = {
		dnsPhase: 3,
		tcpPhase: 7,
	};

	request.emit('socket', socket);

	t.is(timings.phases.dns, 3);
	t.is(timings.phases.tcp, 7);
	t.is(timings.phases.tls, undefined);
	t.is(timings.secureConnect, undefined);
});

test('timer handles socket reuse without stored timings', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({writable: true, connecting: false});

	// No __initial_connection_timings__ stored
	request.emit('socket', socket);

	// Should set phases to 0 and timestamps to socket time
	t.is(timings.lookup, timings.socket);
	t.is(timings.connect, timings.socket);
	t.is(timings.phases.dns, 0);
	t.is(timings.phases.tcp, 0);
});

// Note: HTTP/2 proxy socket behavior is tested in integration tests (test/timings.ts)

test('timer stores connection timings on socket for reuse', async t => {
	const request = createMockRequest();
	timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('lookup');
	await delay(5);
	socket.emit('connect');

	// Verify timings are stored on socket
	t.truthy(socket.__initial_connection_timings__);
	t.is(typeof socket.__initial_connection_timings__.dnsPhase, 'number');
	t.is(typeof socket.__initial_connection_timings__.tcpPhase, 'number');
	t.true(socket.__initial_connection_timings__.dnsPhase >= 0);
	t.true(socket.__initial_connection_timings__.tcpPhase >= 0);
});

test('timer measures upload timing', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('connect');
	await delay(10);
	request.emit('finish');

	t.is(typeof timings.upload, 'number');
	t.true(timings.upload! >= timings.connect!);
});

test('timer handles already finished write', t => {
	const request = createMockRequest();
	request.writableFinished = true;
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('connect');

	t.is(typeof timings.upload, 'number');
});

test('timer measures response timing', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	const response = createMockResponse();

	request.emit('socket', socket);
	socket.emit('connect');
	request.emit('finish');
	await delay(10);
	request.emit('response', response);

	t.is(typeof timings.response, 'number');
	t.is(typeof timings.phases.firstByte, 'number');
	t.true(timings.phases.firstByte! >= 0);
	t.is(timings.phases.firstByte, timings.response! - timings.upload!);
});

test('timer measures download timing', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	const response = createMockResponse();

	request.emit('socket', socket);
	socket.emit('connect');
	request.emit('finish');
	request.emit('response', response);
	await delay(10);
	response.emit('end');

	t.is(typeof timings.end, 'number');
	t.is(typeof timings.phases.download, 'number');
	t.is(typeof timings.phases.total, 'number');
	t.true(timings.phases.download! >= 0);
	t.true(timings.phases.total! > 0);
	t.is(timings.phases.download, timings.end! - timings.response!);
	t.is(timings.phases.total, timings.end! - timings.start);
});

test('timer captures error timing', t => {
	const request = createMockRequest();
	const timings = timer(request);

	// Add error handler to prevent unhandled error
	request.on('error', () => {});

	const error = new Error('Test error');
	request.emit('error', error);

	t.is(typeof timings.error, 'number');
	t.is(typeof timings.phases.total, 'number');
	t.is(timings.phases.total, timings.error! - timings.start);
});

test('timer captures abort timing', t => {
	const request = createMockRequest();
	const timings = timer(request);

	request.emit('abort');

	t.is(typeof timings.abort, 'number');
	t.is(typeof timings.phases.total, 'number');
	t.is(timings.phases.total, timings.abort! - timings.start);
});

test('timer handles response abort', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	const response = createMockResponse();

	request.emit('socket', socket);
	socket.emit('connect');
	request.emit('finish');
	request.emit('response', response);
	response.emit('aborted');

	t.is(typeof timings.abort, 'number');
	t.is(typeof timings.phases.total, 'number');
});

test('timer does not overwrite total phase on normal completion', t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	const response = createMockResponse();

	request.emit('socket', socket);
	socket.emit('connect');
	request.emit('finish');
	request.emit('response', response);

	// Simulate abort before end
	response.emit('aborted');
	const abortTotal = timings.phases.total;

	// Now emit end - should not overwrite the abort total
	response.emit('end');

	t.is(timings.phases.total, abortTotal, 'should preserve abort total');
});

test('timer calculates request phase correctly', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('connect');
	await delay(10);
	request.emit('finish');

	t.is(typeof timings.phases.request, 'number');
	t.true(timings.phases.request! >= 0);
	t.is(timings.phases.request, timings.upload! - timings.connect!);
});

test('timer calculates request phase with TLS', async t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	socket.encrypted = true;
	socket.authorized = false;

	request.emit('socket', socket);
	socket.emit('connect');
	socket.emit('secureConnect');
	await delay(10);
	request.emit('finish');

	t.is(typeof timings.phases.request, 'number');
	t.true(timings.phases.request! >= 0);
	t.is(timings.phases.request, timings.upload! - timings.secureConnect!);
});

// HTTP/2 request phase test is not included here because it requires mocking util.types.isProxy
// which is difficult in ESM. This behavior is tested in integration tests with actual HTTP/2 requests.
