import test from 'ava';
import pEvent from 'p-event';
import delay from 'delay';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', async (req, res) => {
		await delay(20);
		res.statusCode = 200;
		res.end('OK');
	});

	await s.listen(s.port);
});

test('timeout option', async t => {
	const err = await t.throws(got(`${s.url}/`, {
		timeout: 1,
		retries: 0
	}));

	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('timeout option as object', async t => {
	const err = await t.throws(got(`${s.url}`, {
		timeout: {socket: 50, request: 1},
		retries: 0
	}));

	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('socket timeout', async t => {
	const err = await t.throws(got(`${s.url}`, {
		timeout: {socket: 1},
		retries: 0
	}));

	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('connection, request timeout', async t => {
	const err = await t.throws(got(`${s.url}`, {
		timeout: {socket: 50, request: 1},
		retries: 0
	}));

	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('retries on timeout, ESOCKETTIMEDOUT', async t => {
	let tried = false;

	const err = await t.throws(got(`${s.url}`, {
		timeout: 1,
		retries: () => {
			if (tried) {
				return 0;
			}

			tried = true;
			return 1;
		}
	}));

	t.true(tried);
	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('retries on timeout, ETIMEDOUT', async t => {
	let tried = false;

	const err = await t.throws(got(`${s.url}`, {
		timeout: 15,
		retries: () => {
			if (tried) {
				return 0;
			}

			tried = true;
			return 1;
		}
	}));

	t.true(tried);
	t.is(err.code, 'ETIMEDOUT');
});

test('timeout with streams', async t => {
	const stream = got.stream(s.url, {timeout: 1, retries: 0});
	const err = await t.throws(pEvent(stream, 'response'));
	t.is(err.code, 'ESOCKETTIMEDOUT');
});
