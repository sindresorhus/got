import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/', (req, res) => {
		res.statusCode = 200;
		res.end('OK');
	});
});

test('timeout option', async t => {
	const err = await t.throws(got(s.url, {
		timeout: 1,
		retries: 0
	}));

	t.is(err.code, 'ETIMEDOUT');
});

test('timeout option as object', async t => {
	const err = await t.throws(got(s.url, {
		timeout: {socket: 50, request: 1},
		retries: 0
	}));

	t.is(err.code, 'ETIMEDOUT');
});

test('socket timeout', async t => {
	const err = await t.throws(got(s.url, {
		timeout: {socket: 1},
		retries: 0
	}));

	t.is(err.code, 'ESOCKETTIMEDOUT');
});

test('connection, request timeout', async t => {
	const err = await t.throws(got(s.url, {
		timeout: {socket: 50, request: 1},
		retries: 0
	}));

	t.is(err.code, 'ETIMEDOUT');
});

test.cb('timeout with streams', t => {
	got.stream(s.url, {timeout: 1, retries: 0})
		.on('error', err => {
			t.is(err.code, 'ETIMEDOUT');
			t.end();
		})
		.on('data', t.end);
});
