import test from 'ava';
import got from '../dist';

// TODO: Use `getActiveResources()` instead when it's out:
// https://github.com/nodejs/node/pull/21453
// eslint-disable-next-line node/no-deprecated-api
const {Timer} = process.binding('timer_wrap');

test.serial('clear the progressInterval if the socket has been destroyed', async t => {
	const error = await t.throwsAsync(got('http://127.0.0.1:55555', {retry: 0}));
	const progressIntervalTimer = process._getActiveHandles().filter(handle => {
		// Check if the handle is a Timer that matches the `uploadEventFrequency` interval
		return handle instanceof Timer && handle._list.msecs === 150;
	});
	t.is(progressIntervalTimer.length, 0);
	t.is(error.code, 'ECONNREFUSED');
});
