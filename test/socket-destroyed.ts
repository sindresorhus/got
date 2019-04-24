import test from 'ava';
import got from '../source';

// TODO: Use `getActiveResources()` instead of `process.binding('timer_wrap')` when it's out:
// https://github.com/nodejs/node/pull/21453
// eslint-disable-next-line ava/no-skip-test
test.skip('clear the progressInterval if the socket has been destroyed', async t => {
	// @ts-ignore
	const {Timer} = process.binding('timer_wrap'); // eslint-disable-line node/no-deprecated-api

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
