import test from 'ava';
import got from '../source';

// TODO: Use `getActiveResources()` instead when it's out:
// https://github.com/nodejs/node/pull/21453
// @ts-ignore
const {Timer} = process.binding('timer_wrap'); // eslint-disable-line node/no-deprecated-api

test('clear the progressInterval if the socket has been destroyed', async t => {
	await t.throwsAsync(got('http://127.0.0.1:55555', {retry: 0}), {
		code: 'ECONNREFUSED'
	});

	// @ts-ignore
	const progressIntervalTimer = process._getActiveHandles().filter(handle => {
		// Check if the handle is a Timer that matches the `uploadEventFrequency` interval
		return handle instanceof Timer && handle._list.msecs === 150;
	});
	t.is(progressIntervalTimer.length, 0);
});
