import {EventEmitter} from 'node:events';
import type {ClientRequest} from 'node:http';
import type {Socket} from 'node:net';
import test from 'ava';
import FakeTimers from '@sinonjs/fake-timers';
import timedOut from '../source/core/timed-out.js';

for (const hostname of ['[::1]', '[2001:db8::1]', '::1', '127.0.0.1', 'example.com']) {
	for (const connecting of [true, false]) {
		test.serial(`timeout selection for ${hostname} with connecting=${connecting}`, t => {
			const clock = FakeTimers.install();
			t.teardown(() => {
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
			t.teardown(cancel);
			request.emit('socket', socket);

			clock.tick(15);
			if (connecting && hostname === 'example.com') {
				t.like(errors[0], {event: 'lookup', code: 'ETIMEDOUT'});
				return;
			}

			t.deepEqual(errors, []);
			clock.tick(10);
			if (connecting) {
				t.like(errors[0], {event: 'connect', code: 'ETIMEDOUT'});
			} else {
				t.deepEqual(errors, []);
			}
		});
	}
}
