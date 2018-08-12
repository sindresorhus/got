import test from 'ava';
import pEvent from 'p-event';
import got from '../source';
import {createServer} from './helpers/server';

let s;
let trys = 0;
let knocks = 0;
let fifth = 0;
let lastTried413access = Date.now();
let lastTried413TimestampAccess;

const retryAfterOn413 = 2;
const socketTimeout = 200;

test.before('setup', async () => {
	s = await createServer();

	s.on('/long', () => {});

	s.on('/knock-twice', (request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
		}
	});

	s.on('/try-me', () => {
		trys++;
	});

	s.on('/fifth', (request, response) => {
		if (fifth++ === 5) {
			response.end('who`s there?');
		}
	});

	s.on('/500', (request, response) => {
		response.statusCode = 500;
		response.end();
	});

	s.on('/measure413', (request, response) => {
		response.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		response.end((Date.now() - lastTried413access).toString());

		lastTried413access = Date.now();
	});

	s.on('/413', (request, response) => {
		response.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		response.end();
	});

	s.on('/413withTimestamp', (request, response) => {
		const date = (new Date(Date.now() + (retryAfterOn413 * 1000))).toUTCString();

		response.writeHead(413, {
			'Retry-After': date
		});
		response.end(lastTried413TimestampAccess);
		lastTried413TimestampAccess = date;
	});

	s.on('/413withoutRetryAfter', (request, response) => {
		response.statusCode = 413;
		response.end();
	});

	s.on('/503', (request, response) => {
		response.statusCode = 503;
		response.end();
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('works on timeout error', async t => {
	t.is((await got(`${s.url}/knock-twice`, {timeout: {socket: socketTimeout}})).body, 'who`s there?');
});

test('can be disabled with option', async t => {
	const error = await t.throwsAsync(got(`${s.url}/try-me`, {
		timeout: {socket: socketTimeout},
		retry: 0
	}));
	t.truthy(error);
	t.is(trys, 1);
});

test('function gets iter count', async t => {
	await got(`${s.url}/fifth`, {
		timeout: {socket: socketTimeout},
		retry: {
			retries: iteration => iteration < 10
		}
	});
	t.is(fifth, 6);
});

test('falsy value prevents retries', async t => {
	const error = await t.throwsAsync(got(`${s.url}/long`, {
		timeout: {socket: socketTimeout},
		retry: {
			retries: () => 0
		}
	}));
	t.truthy(error);
});

test('falsy value prevents retries #2', async t => {
	const error = await t.throwsAsync(got(`${s.url}/long`, {
		timeout: {socket: socketTimeout},
		retry: {
			retries: (iter, error) => {
				t.truthy(error);
				return false;
			}
		}
	}));
	t.truthy(error);
});

test('custom retries', async t => {
	let tried = false;
	const error = await t.throwsAsync(got(`${s.url}/500`, {
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
	t.is(error.statusCode, 500);
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

test('respect 413 Retry-After with RFC-1123 timestamp', async t => {
	const {statusCode, body} = await got(`${s.url}/413withTimestamp`, {
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Date.now() >= Date.parse(body));
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
		retry: {
			retries: () => {
				t.fail('Retries on streams');
			}
		}
	});
	await t.throwsAsync(pEvent(stream, 'response'));
});

test('doesn\'t retry if Retry-After header is greater than maxRetryAfter', async t => {
	const {retryCount} = await got(`${s.url}/413`, {
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('doesn\'t retry when set to false', async t => {
	const {statusCode, retryCount} = await got(`${s.url}/413`, {
		throwHttpErrors: false,
		retry: false
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('works when defaults.options.retry is not an object', async t => {
	const instance = got.extend({
		retry: 2
	});

	const {retryCount} = await instance(`${s.url}/413`, {
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retry function can throw', async t => {
	const error = 'Simple error';
	await t.throwsAsync(got(`${s.url}/413`, {
		retry: {
			retries: () => {
				throw new Error(error);
			}
		}
	}), error);
});
