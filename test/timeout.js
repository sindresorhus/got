import test from 'ava';
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
	try {
		await got(`${s.url}/`, {
			timeout: 1,
			retries: 0
		});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('timeout option as object', async t => {
	try {
		await got(`${s.url}/404`, {
			timeout: {socket: 50, request: 1},
			retries: 0
		});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('socket timeout', async t => {
	try {
		await got(`${s.url}/404`, {
			timeout: {socket: 1},
			retries: 0
		});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ESOCKETTIMEDOUT');
	}
});

test('connection, request timeout', async t => {
	try {
		await got(`${s.url}/404`, {
			timeout: {socket: 50, request: 1},
			retries: 0
		});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});
