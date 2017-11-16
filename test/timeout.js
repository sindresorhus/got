import test from 'ava';
import pEvent from 'p-event';
import got from '..';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
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

	t.is(err.code, 'ETIMEDOUT');
});

test('timeout option as object', async t => {
	const err = await t.throws(got(`${s.url}/404`, {
		timeout: {socket: 50, request: 1},
		retries: 0
	}));

	t.is(err.code, 'ETIMEDOUT');
});

test('socket timeout', async t => {
	const err = await t.throws(got(`${s.url}/404`, {
		timeout: {socket: 1},
		retries: 0
	}));

	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('connection, request timeout', async t => {
	const err = await t.throws(got(`${s.url}/404`, {
		timeout: {socket: 50, request: 1},
		retries: 0
	}));

	t.is(err.code, 'ETIMEDOUT');
});

test('timeout with streams', async t => {
	const stream = got.stream(s.url, {timeout: 1, retries: 0});
	const err = await t.throws(pEvent(stream, 'response'));
	t.is(err.code, 'ETIMEDOUT');
});
