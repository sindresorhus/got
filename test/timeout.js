import test from 'ava';
import pEvent from 'p-event';
import delay from 'delay';
import got from '../source';
import {createServer} from './helpers/server';

let s;
const reqDelay = 160;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', async (req, res) => {
		await delay(reqDelay);
		res.statusCode = 200;
		res.end('OK');
	});

	await s.listen(s.port);
});

test('timeout option (ETIMEDOUT)', async t => {
	await t.throws(
		got(s.url, {
			timeout: 0,
			retry: 0
		}),
		{
			code: 'ETIMEDOUT'
		}
	);
});

test('timeout option (ESOCKETTIMEDOUT)', async t => {
	await t.throws(
		got(s.url, {
			timeout: reqDelay,
			retry: 0
		}),
		{
			code: 'ESOCKETTIMEDOUT'
		}
	);
});

test('timeout option as object (ETIMEDOUT)', async t => {
	await t.throws(
		got(s.url, {
			timeout: {socket: reqDelay * 2.5, request: 0},
			retry: 0
		}),
		{
			code: 'ETIMEDOUT'
		}
	);
});

test('timeout option as object (ESOCKETTIMEDOUT)', async t => {
	await t.throws(
		got(s.url, {
			timeout: {socket: reqDelay * 1.5, request: reqDelay},
			retry: 0
		}),
		{
			code: 'ESOCKETTIMEDOUT'
		}
	);
});

test('socket timeout', async t => {
	await t.throws(
		got(s.url, {
			timeout: {socket: reqDelay / 20},
			retry: 0
		}),
		{
			code: 'ESOCKETTIMEDOUT'
		}
	);
});

test.todo('connection timeout');

test('request timeout', async t => {
	await t.throws(
		got(s.url, {
			timeout: {request: reqDelay},
			retry: 0
		}),
		{
			code: 'ESOCKETTIMEDOUT'
		}
	);
});

test('retries on timeout (ESOCKETTIMEDOUT)', async t => {
	let tried = false;

	await t.throws(got(s.url, {
		timeout: reqDelay,
		retry: {
			retries: () => {
				if (tried) {
					return 0;
				}

				tried = true;
				return 1;
			}
		}
	}), {
		code: 'ESOCKETTIMEDOUT'
	});

	t.true(tried);
});

test('retries on timeout (ETIMEDOUT)', async t => {
	let tried = false;

	await t.throws(got(s.url, {
		timeout: 0,
		retry: {
			retries: () => {
				if (tried) {
					return 0;
				}

				tried = true;
				return 1;
			}
		}
	}), {code: 'ETIMEDOUT'});

	t.true(tried);
});

test('timeout with streams', async t => {
	const stream = got.stream(s.url, {
		timeout: 0,
		retry: 0
	});
	await t.throws(pEvent(stream, 'response'), {code: 'ETIMEDOUT'});
});
