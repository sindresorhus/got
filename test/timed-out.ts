import {EventEmitter} from 'node:events';
import type {ClientRequest} from 'node:http';
import type {Socket} from 'node:net';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import FakeTimers from '@sinonjs/fake-timers';
import timedOut, {TimeoutError} from '../source/core/timed-out.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';

const createRequest = (t: TestContext) => {
	const clock = FakeTimers.install();
	t.after(() => {
		clock.uninstall();
	});
	const request = new EventEmitter() as ClientRequest;
	const errors: Array<Error | undefined> = [];
	request.setTimeout = (_milliseconds, callback) => {
		if (callback) {
			request.once('timeout', callback);
		}

		return request;
	};

	request.destroy = error => {
		errors.push(error);
		return request;
	};

	return {request, clock, errors};
};

test.serial('canceling timeouts prevents a queued socket timeout from destroying the request', t => {
	const {request, clock, errors} = createRequest(t);
	const cancel = timedOut(request, {socket: 10}, {protocol: 'http:', hostname: 'localhost'});

	request.emit('timeout');
	cancel();
	cancel();
	clock.runAll();

	assert.deepStrictEqual([...errors], []);
	assert.strictEqual(request.listenerCount('timeout'), 0);
});

test.serial('an active socket timeout retains its error details', t => {
	const {request, clock, errors} = createRequest(t);
	const cancel = timedOut(request, {socket: 10}, {protocol: 'http:', hostname: 'localhost'});

	request.emit('timeout');
	assert.deepStrictEqual([...errors], []);
	clock.runAll();

	assert.ok(errorMatching(TimeoutError, {code: 'ETIMEDOUT', event: 'socket', message: 'Timeout awaiting \'socket\' for 10ms'})(errors[0]));
	assert.strictEqual(errors.length, 1);
	cancel();
	request.emit('timeout');
	clock.runAll();
	assert.strictEqual(errors.length, 1);
});

test.serial('canceling before a socket timeout removes its listener', t => {
	const {request, clock, errors} = createRequest(t);
	const cancel = timedOut(request, {socket: 10}, {protocol: 'http:', hostname: 'localhost'});

	cancel();
	request.emit('timeout');
	clock.runAll();

	assert.deepStrictEqual([...errors], []);
	assert.strictEqual(request.listenerCount('timeout'), 0);
});

test.serial('canceling timeouts removes the listeners attached to the socket', t => {
	const {request} = createRequest(t);
	const socket = new EventEmitter() as Socket;
	Object.defineProperty(socket, 'connecting', {value: true});
	socket.address = () => ({});

	const cancel = timedOut(request, {
		lookup: 10,
		connect: 20,
		secureConnect: 30,
		send: 40,
	}, {protocol: 'https:', hostname: 'example.com'});
	request.emit('socket', socket);
	assert.ok(socket.listenerCount('lookup') > 0);

	// Each event attaches the listeners of the next phase, which `cancel` must also remove.
	socket.emit('lookup', null);
	assert.ok(socket.listenerCount('connect') > 0);

	socket.emit('connect');
	assert.ok(socket.listenerCount('secureConnect') > 0);
	assert.ok(request.listenerCount('upload-complete') > 0);

	cancel();

	for (const event of ['lookup', 'connect', 'secureConnect']) {
		assert.strictEqual(socket.listenerCount(event), 0, event);
	}

	assert.strictEqual(request.listenerCount('upload-complete'), 0);
});

test.serial('another request error cancels an already queued socket timeout', t => {
	const {request, clock, errors} = createRequest(t);
	request.on('error', () => {});
	timedOut(request, {socket: 10}, {protocol: 'http:', hostname: 'localhost'});

	request.emit('timeout');
	request.emit('error', new Error('connection failed'));
	clock.runAll();

	assert.deepStrictEqual([...errors], []);
	assert.strictEqual(request.listenerCount('timeout'), 0);
});

for (const hostname of ['[::1]', '[2001:db8::1]', '::1', '127.0.0.1', 'example.com']) {
	for (const connecting of [true, false]) {
		test.serial(`timeout selection for ${hostname} with connecting=${connecting}`, t => {
			const clock = FakeTimers.install();
			t.after(() => {
				clock.uninstall();
			});
			const socket = new EventEmitter() as Socket;
			Object.defineProperty(socket, 'connecting', {value: connecting});
			socket.address = () => ({});
			const request = new EventEmitter() as ClientRequest;
			const errors: Array<Error | undefined> = [];
			request.destroy = error => {
				errors.push(error);
				return request;
			};

			const cancel = timedOut(request, {lookup: 10, connect: 20}, {hostname, protocol: 'http:'});
			t.after(cancel);
			request.emit('socket', socket);

			clock.tick(15);
			if (connecting && hostname === 'example.com') {
				assert.ok(errorMatching(TimeoutError, {event: 'lookup', code: 'ETIMEDOUT'})(errors[0]));
				return;
			}

			assert.deepStrictEqual([...errors], []);
			clock.tick(10);
			if (connecting) {
				assert.ok(errorMatching(TimeoutError, {event: 'connect', code: 'ETIMEDOUT'})(errors[0]));
			} else {
				assert.deepStrictEqual([...errors], []);
			}
		});
	}
}
