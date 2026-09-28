import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import FakeTimers from '@sinonjs/fake-timers';
import timer from '../source/core/utils/timer.js';
import test from './helpers/test.js';

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

test('timer returns same object on subsequent calls (singleton)', _t => {
	const request = createMockRequest();
	const timings1 = timer(request);
	const timings2 = timer(request);

	assert.strictEqual(timings1, timings2, 'should return the same timings object');
});

test('timer initializes all properties to undefined except start', _t => {
	const request = createMockRequest();
	const timings = timer(request);

	assert.strictEqual(typeof timings.start, 'number');
	assert.strictEqual(timings.socket, undefined);
	assert.strictEqual(timings.lookup, undefined);
	assert.strictEqual(timings.connect, undefined);
	assert.strictEqual(timings.secureConnect, undefined);
	assert.strictEqual(timings.upload, undefined);
	assert.strictEqual(timings.response, undefined);
	assert.strictEqual(timings.end, undefined);
	assert.strictEqual(timings.error, undefined);
	assert.strictEqual(timings.abort, undefined);

	assert.strictEqual(timings.phases.wait, undefined);
	assert.strictEqual(timings.phases.dns, undefined);
	assert.strictEqual(timings.phases.tcp, undefined);
	assert.strictEqual(timings.phases.tls, undefined);
	assert.strictEqual(timings.phases.request, undefined);
	assert.strictEqual(timings.phases.firstByte, undefined);
	assert.strictEqual(timings.phases.download, undefined);
	assert.strictEqual(timings.phases.total, undefined);
});

test('timer sets socket timing when socket event fires', _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);

	assert.strictEqual(typeof timings.socket, 'number');
	assert.strictEqual(typeof timings.phases.wait, 'number');
	assert.strictEqual(timings.phases.wait! >= 0, true);
});

test('timer handles already attached socket', _t => {
	const request = createMockRequest();
	const socket = createMockSocket({connecting: true});
	request.socket = socket;

	const timings = timer(request);

	assert.strictEqual(typeof timings.socket, 'number');
	assert.strictEqual(typeof timings.phases.wait, 'number');
});

test('timer measures DNS lookup timing', async _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	await delay(10);
	socket.emit('lookup');
	await delay(5);
	socket.emit('connect');

	assert.strictEqual(typeof timings.lookup, 'number');
	assert.strictEqual(typeof timings.phases.dns, 'number');
	assert.strictEqual(timings.phases.dns! > 0, true);
	assert.strictEqual(timings.phases.dns, timings.lookup! - timings.socket!);
});

test.serial('timer reports zero DNS phase when cached lookup and connect share timestamp', _t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		const request = createMockRequest();
		const timings = timer(request);
		const socket = createMockSocket({connecting: true});

		request.emit('socket', socket);
		clock.tick(10);
		socket.emit('lookup');
		socket.emit('connect');

		assert.strictEqual(timings.phases.tcp, 0);
		assert.strictEqual(timings.phases.dns, 0);
	} finally {
		clock.uninstall();
	}
});

test('timer handles IP address connection (no DNS lookup)', _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	// Emit connect without lookup (simulates IP address connection)
	socket.emit('connect');

	assert.strictEqual(timings.lookup, timings.socket);
	assert.strictEqual(timings.phases.dns, 0);
	assert.strictEqual(typeof timings.connect, 'number');
});

test('timer measures TCP connection timing', async _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('lookup');
	await delay(10);
	socket.emit('connect');

	assert.strictEqual(typeof timings.connect, 'number');
	assert.strictEqual(typeof timings.phases.tcp, 'number');
	assert.strictEqual(timings.phases.tcp! >= 0, true);
	assert.strictEqual(timings.phases.tcp, timings.connect! - timings.lookup!);
});

test('timer measures TLS handshake timing', async _t => {
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

	assert.strictEqual(typeof timings.secureConnect, 'number');
	assert.strictEqual(typeof timings.phases.tls, 'number');
	assert.strictEqual(timings.phases.tls! > 0, true);
	assert.strictEqual(timings.phases.tls, timings.secureConnect! - timings.connect!);
});

test('timer handles socket reuse with stored timings', _t => {
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
	assert.strictEqual(timings.phases.dns, 5);
	assert.strictEqual(timings.phases.tcp, 10);
	assert.strictEqual(timings.phases.tls, 15);

	// Verify all timestamps are at socket time (no new connection for THIS request)
	assert.strictEqual(timings.lookup, timings.socket);
	assert.strictEqual(timings.connect, timings.socket);
	assert.strictEqual(timings.secureConnect, timings.socket);
});

test('timer handles socket reuse without TLS', _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({writable: true, connecting: false});

	socket.__initial_connection_timings__ = {
		dnsPhase: 3,
		tcpPhase: 7,
	};

	request.emit('socket', socket);

	assert.strictEqual(timings.phases.dns, 3);
	assert.strictEqual(timings.phases.tcp, 7);
	assert.strictEqual(timings.phases.tls, undefined);
	assert.strictEqual(timings.secureConnect, undefined);
});

test('timer handles socket reuse without stored timings', _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({writable: true, connecting: false});

	// No __initial_connection_timings__ stored
	request.emit('socket', socket);

	// Should set phases to 0 and timestamps to socket time
	assert.strictEqual(timings.lookup, timings.socket);
	assert.strictEqual(timings.connect, timings.socket);
	assert.strictEqual(timings.phases.dns, 0);
	assert.strictEqual(timings.phases.tcp, 0);
});

// Note: HTTP/2 proxy socket behavior is tested in integration tests (test/timings.ts)

test('timer stores connection timings on socket for reuse', async _t => {
	const request = createMockRequest();
	timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('lookup');
	await delay(5);
	socket.emit('connect');

	// Verify timings are stored on socket
	assert.ok(socket.__initial_connection_timings__);
	assert.strictEqual(typeof socket.__initial_connection_timings__.dnsPhase, 'number');
	assert.strictEqual(typeof socket.__initial_connection_timings__.tcpPhase, 'number');
	assert.strictEqual(socket.__initial_connection_timings__.dnsPhase >= 0, true);
	assert.strictEqual(socket.__initial_connection_timings__.tcpPhase >= 0, true);
});

test('timer measures upload timing', async _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('connect');
	await delay(10);
	request.emit('finish');

	assert.strictEqual(typeof timings.upload, 'number');
	assert.strictEqual(timings.upload! >= timings.connect!, true);
});

test('timer handles already finished write', _t => {
	const request = createMockRequest();
	request.writableFinished = true;
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('connect');

	assert.strictEqual(typeof timings.upload, 'number');
});

test('timer measures response timing', async _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	const response = createMockResponse();

	request.emit('socket', socket);
	socket.emit('connect');
	request.emit('finish');
	await delay(10);
	request.emit('response', response);

	assert.strictEqual(typeof timings.response, 'number');
	assert.strictEqual(typeof timings.phases.firstByte, 'number');
	assert.strictEqual(timings.phases.firstByte! >= 0, true);
	assert.strictEqual(timings.phases.firstByte, timings.response! - timings.upload!);
});

test('timer measures download timing', async _t => {
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

	assert.strictEqual(typeof timings.end, 'number');
	assert.strictEqual(typeof timings.phases.download, 'number');
	assert.strictEqual(typeof timings.phases.total, 'number');
	assert.strictEqual(timings.phases.download! >= 0, true);
	assert.strictEqual(timings.phases.total! > 0, true);
	assert.strictEqual(timings.phases.download, timings.end! - timings.response!);
	assert.strictEqual(timings.phases.total, timings.end! - timings.start);
});

test('timer captures error timing', _t => {
	const request = createMockRequest();
	const timings = timer(request);

	// Add error handler to prevent unhandled error
	request.on('error', () => {});

	const error = new Error('Test error');
	request.emit('error', error);

	assert.strictEqual(typeof timings.error, 'number');
	assert.strictEqual(typeof timings.phases.total, 'number');
	assert.strictEqual(timings.phases.total, timings.error! - timings.start);
});

test('timer captures abort timing', _t => {
	const request = createMockRequest();
	const timings = timer(request);

	request.emit('abort');

	assert.strictEqual(typeof timings.abort, 'number');
	assert.strictEqual(typeof timings.phases.total, 'number');
	assert.strictEqual(timings.phases.total, timings.abort! - timings.start);
});

test('timer handles response abort', _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});
	const response = createMockResponse();

	request.emit('socket', socket);
	socket.emit('connect');
	request.emit('finish');
	request.emit('response', response);
	response.emit('aborted');

	assert.strictEqual(typeof timings.abort, 'number');
	assert.strictEqual(typeof timings.phases.total, 'number');
});

test('timer does not overwrite total phase on normal completion', _t => {
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

	assert.strictEqual(timings.phases.total, abortTotal, 'should preserve abort total');
});

test('timer calculates request phase correctly', async _t => {
	const request = createMockRequest();
	const timings = timer(request);
	const socket = createMockSocket({connecting: true});

	request.emit('socket', socket);
	socket.emit('connect');
	await delay(10);
	request.emit('finish');

	assert.strictEqual(typeof timings.phases.request, 'number');
	assert.strictEqual(timings.phases.request! >= 0, true);
	assert.strictEqual(timings.phases.request, timings.upload! - timings.connect!);
});

test('timer calculates request phase with TLS', async _t => {
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

	assert.strictEqual(typeof timings.phases.request, 'number');
	assert.strictEqual(timings.phases.request! >= 0, true);
	assert.strictEqual(timings.phases.request, timings.upload! - timings.secureConnect!);
});

// HTTP/2 request phase test is not included here because it requires mocking util.types.isProxy
// which is difficult in ESM. This behavior is tested in integration tests with actual HTTP/2 requests.
