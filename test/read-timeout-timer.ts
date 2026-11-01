import assert from 'node:assert/strict';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import FakeTimers from '@sinonjs/fake-timers';
import {timedOutRead, TimeoutError} from '../source/core/timed-out.js';
import test from './helpers/test.js';

for (const phase of ['armed', 'queued']) {
	for (const completion of ['cancel', 'end', 'close']) {
		test.serial(`a ${phase} read timer releases all resources on ${completion}`, t => {
			const response = new IncomingMessage(new Socket());
			const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
			t.after(() => {
				clock.uninstall();
				response.destroy();
			});
			let failures = 0;
			const cancel = timedOutRead(response, 10, () => {
				failures++;
			});
			if (phase === 'queued') {
				clock.tick(10);
			}

			if (completion === 'cancel') {
				cancel();
				cancel();
			} else {
				response.emit(completion);
			}

			assert.strictEqual(clock.countTimers(), 0);
			assert.strictEqual(response.listenerCount('end'), 0);
			assert.strictEqual(response.listenerCount('close'), 0);
			clock.runAll();
			assert.strictEqual(failures, 0);
		});
	}
}

test.serial('an expired read timer reports once and releases its response listeners', t => {
	const response = new IncomingMessage(new Socket());
	const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
	t.after(() => {
		clock.uninstall();
		response.destroy();
	});
	const errors: TimeoutError[] = [];
	const cancel = timedOutRead(response, 10, error => {
		errors.push(error);
	});
	clock.tick(10);
	assert.strictEqual(errors.length, 0);
	clock.runAll();
	assert.strictEqual(errors.length, 1);
	assert.ok(errors[0] instanceof TimeoutError);
	assert.strictEqual(errors[0].event, 'read');
	assert.strictEqual(errors[0].code, 'ETIMEDOUT');
	assert.strictEqual(response.listenerCount('end'), 0);
	assert.strictEqual(response.listenerCount('close'), 0);
	assert.strictEqual(clock.countTimers(), 0);
	cancel();
	clock.runAll();
	assert.strictEqual(errors.length, 1);
});

test.serial('a destroyed response does not acquire a read timer', t => {
	const response = new IncomingMessage(new Socket());
	response.destroy();
	const clock = FakeTimers.install({toFake: ['setTimeout', 'clearTimeout']});
	t.after(() => {
		clock.uninstall();
	});
	const cancel = timedOutRead(response, 10, () => {
		assert.fail('A destroyed response must not time out');
	});
	assert.strictEqual(clock.countTimers(), 0);
	cancel();
	clock.runAll();
});
