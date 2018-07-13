import test from 'ava';
import pEvent from 'p-event';
import got from '../source';
import {createServer} from './helpers/server';

let s;
let trys = 0;
let knocks = 0;
let fifth = 0;
let lastTried413access = Date.now();

const retryAfterOn413 = 2;
const connectTimeout = 500;
const socketTimeout = 100;

test.before('setup', async () => {
	s = await createServer();

	s.on('/long', () => {});

	s.on('/knock-twice', (req, res) => {
		if (knocks++ === 1) {
			res.end('who`s there?');
		}
	});

	s.on('/try-me', () => {
		trys++;
	});

	s.on('/fifth', (req, res) => {
		if (fifth++ === 5) {
			res.end('who`s there?');
		}
	});

	s.on('/500', (req, res) => {
		res.statusCode = 500;
		res.end();
	});

	s.on('/measure413', (req, res) => {
		res.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		res.end((Date.now() - lastTried413access).toString());

		lastTried413access = Date.now();
	});

	s.on('/413', (req, res) => {
		res.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		res.end();
	});

	s.on('/413withoutRetryAfter', (req, res) => {
		res.statusCode = 413;
		res.end();
	});

	s.on('/503', (req, res) => {
		res.statusCode = 503;
		res.end();
	});

	await s.listen(s.port);
});

test('works on timeout error', async t => {
	t.is((await got(`${s.url}/knock-twice`, {timeout: {connect: connectTimeout, socket: socketTimeout}})).body, 'who`s there?');
});

test('can be disabled with option', async t => {
	const err = await t.throws(got(`${s.url}/try-me`, {
		timeout: {connect: connectTimeout, socket: socketTimeout},
		retry: 0
	}));
	t.truthy(err);
	t.is(trys, 1);
});

test('function gets iter count', async t => {
	await got(`${s.url}/fifth`, {
		timeout: {connect: connectTimeout, socket: socketTimeout},
		retry: {
			retries: iteration => iteration < 10
		}
	});
	t.is(fifth, 6);
});

test('falsy value prevents retries', async t => {
	const err = await t.throws(got(`${s.url}/long`, {
		timeout: {connect: connectTimeout, socket: socketTimeout},
		retry: {
			retries: () => 0
		}
	}));
	t.truthy(err);
});

test('falsy value prevents retries #2', async t => {
	const err = await t.throws(got(`${s.url}/long`, {
		timeout: {connect: connectTimeout, socket: socketTimeout},
		retry: {
			retries: (iter, err) => {
				t.truthy(err);
				return false;
			}
		}
	}));
	t.truthy(err);
});

test('custom retries', async t => {
	let tried = false;
	const err = await t.throws(got(`${s.url}/500`, {
		throwHttpErrors: true,
		retry: {
			retries: iter => {
				if (iter === 1) {
					tried = true;
					return 1;
				}

				return 0;
			}, methods: [
				'GET'
			], statusCodes: [
				500
			]
		}
	}));
	t.is(err.statusCode, 500);
	t.true(tried);
});

test('respect 413 Retry-After', async t => {
	const {statusCode, body} = await got(`${s.url}/measure413`, {
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Number(body) >= retryAfterOn413 * 1000);
});

test('doesn\'t retry on 413 with empty statusCodes and methods', async t => {
	const {statusCode, retryCount} = await got(`${s.url}/413`, {
		throwHttpErrors: false,
		retry: {
			retries: 1,
			statusCodes: [],
			methods: []
		}
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('doesn\'t retry on 413 with empty methods', async t => {
	const {statusCode, retryCount} = await got(`${s.url}/413`, {
		throwHttpErrors: false,
		retry: {
			retries: 1,
			statusCodes: [413],
			methods: []
		}
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('doesn\'t retry on 413 without Retry-After header', async t => {
	const {retryCount} = await got(`${s.url}/413withoutRetryAfter`, {
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retries on 503 without Retry-After header', async t => {
	const {retryCount} = await got(`${s.url}/503`, {
		throwHttpErrors: false,
		retry: 1
	});
	t.is(retryCount, 1);
});

test('doesn\'t retry on streams', async t => {
	const stream = got.stream(s.url, {
		timeout: 1,
		retries: () => {
			t.fail('Retries on streams');
		}
	});
	await t.throws(pEvent(stream, 'response'));
});

test('doesn\'t retry if Retry-After header is greater than maxRetryAfter', async t => {
	const {retryCount} = await got(`${s.url}/413`, {
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test.after('cleanup', async () => {
	await s.close();
});
