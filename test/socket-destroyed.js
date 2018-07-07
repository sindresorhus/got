import test from 'ava';
import got from '../source';

const {Timer} = process.binding('timer_wrap');

test.serial('clear the progressInterval if the socket has been destroyed', async t => {
	const err = await t.throws(got(`http://127.0.0.1:55555`, {retry: 0}));
	const progressIntervalTimer = process._getActiveHandles().filter(handle => {
		// Check if the handle is a Timer that matches the `uploadEventFrequency` interval
		return handle instanceof Timer && handle._list.msecs === 150;
	});
	t.is(progressIntervalTimer.length, 0);
	t.is(err.code, 'ECONNREFUSED');
});
