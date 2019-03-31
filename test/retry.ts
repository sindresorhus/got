import http from 'http';
import test from 'ava';
import pEvent from 'p-event';
import withServer from './helpers/with-server';

const retryAfterOn413 = 2;
const socketTimeout = 200;

const handler413 = (request, response) => {
	response.writeHead(413, {
		'Retry-After': retryAfterOn413
	});
	response.end();
};

test('works on timeout error', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/knock-twice', (request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
		}
	});

	t.is((await got('knock-twice', {timeout: {socket: socketTimeout}})).body, 'who`s there?');
});

test('can be disabled with option', withServer, async (t, server, got) => {
	let trys = 0;
	server.get('/try-me', () => {
		trys++;
	});

	const error = await t.throwsAsync(() => got('try-me', {
		timeout: {socket: socketTimeout},
		retry: 0
	}));
	t.truthy(error);
	t.is(trys, 1);
});

test('function gets iter count', withServer, async (t, server, got) => {
	let fifth = 0;
	server.get('/fifth', (request, response) => {
		if (fifth++ === 5) {
			response.end('who`s there?');
		}
	});

	await got('fifth', {
		timeout: {socket: socketTimeout},
		retry: {
			retries: iteration => iteration < 10
		}
	});
	t.is(fifth, 6);
});

test('falsy value prevents retries', withServer, async (t, server, got) => {
	server.get('/long', () => {});

	const error = await t.throwsAsync(() => got('long', {
		timeout: {socket: socketTimeout},
		retry: {
			retries: () => 0
		}
	}));
	t.truthy(error);
});

test('falsy value prevents retries #2', withServer, async (t, server, got) => {
	server.get('/long', () => {});

	const error = await t.throwsAsync(() => got('long', {
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

test('custom retries', withServer, async (t, server, got) => {
	server.get('/500', (request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let tried = false;
	const error = await t.throwsAsync(() => got('500', {
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
	// @ts-ignore
	t.is(error.statusCode, 500);
	t.true(tried);
});

test('custom errors', withServer, async (t, server, got) => {
	server.get('/500', (request, response) => {
		response.statusCode = 500;
		response.end();
	});

	const errorCode = 'OH_SNAP';

	let isTried = false;
	const error = await t.throwsAsync(() => got('500', {
		request: (...args) => {
			// @ts-ignore
			const request = http.request(...args);
			if (!isTried) {
				isTried = true;
				const error = new Error('Snap!');
				// @ts-ignore
				error.code = errorCode;

				setTimeout(() => request.emit('error', error));
			}

			return request;
		},
		retry: {
			retries: 1,
			methods: [
				'GET'
			],
			errorCodes: [
				errorCode
			]
		}
	}));

	// @ts-ignore
	t.is(error.statusCode, 500);
	t.true(isTried);
});

test('respect 413 Retry-After', withServer, async (t, server, got) => {
	let lastTried413access = Date.now();
	server.get('/measure413', (request, response) => {
		response.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		response.end((Date.now() - lastTried413access).toString());

		lastTried413access = Date.now();
	});

	const {statusCode, body} = await got('measure413', {
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Number(body) >= retryAfterOn413 * 1000);
});

test('respect 413 Retry-After with RFC-1123 timestamp', withServer, async (t, server, got) => {
	let lastTried413TimestampAccess;
	server.get('/413withTimestamp', (request, response) => {
		const date = (new Date(Date.now() + (retryAfterOn413 * 1000))).toUTCString();

		response.writeHead(413, {
			'Retry-After': date
		});
		response.end(lastTried413TimestampAccess);
		lastTried413TimestampAccess = date;
	});

	const {statusCode, body} = await got('413withTimestamp', {
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Date.now() >= Date.parse(body));
});

test('doesn\'t retry on 413 with empty statusCodes and methods', withServer, async (t, server, got) => {
	server.get('/413', handler413);

	const {statusCode, retryCount} = await got('413', {
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

test('doesn\'t retry on 413 with empty methods', withServer, async (t, server, got) => {
	server.get('/413', handler413);

	const {statusCode, retryCount} = await got('413', {
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

test('doesn\'t retry on 413 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/413withoutRetryAfter', (request, response) => {
		response.statusCode = 413;
		response.end();
	});

	const {retryCount} = await got('413withoutRetryAfter', {
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retries on 503 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/503', (request, response) => {
		response.statusCode = 503;
		response.end();
	});

	const {retryCount} = await got('503', {
		throwHttpErrors: false,
		retry: 1
	});
	t.is(retryCount, 1);
});

test('doesn\'t retry on streams', withServer, async (t, server, got) => {
	server.get('/', () => {});

	const stream = got.stream({
		timeout: 1,
		retry: {
			retries: () => {
				t.fail('Retries on streams');
			}
		}
	});
	await t.throwsAsync(pEvent(stream, 'response'));
});

test('doesn\'t retry if Retry-After header is greater than maxRetryAfter', withServer, async (t, server, got) => {
	server.get('/413', handler413);

	const {retryCount} = await got('413', {
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('doesn\'t retry when set to false', withServer, async (t, server, got) => {
	server.get('/413', handler413);

	const {statusCode, retryCount} = await got('413', {
		throwHttpErrors: false,
		retry: false
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('works when defaults.options.retry is not an object', withServer, async (t, server, got) => {
	server.get('/413', handler413);

	const instance = got.extend({
		retry: 2
	});

	const {retryCount} = await instance('413', {
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retry function can throw', withServer, async (t, server, got) => {
	server.get('/413', handler413);

	const error = 'Simple error';
	await t.throwsAsync(() => got('413', {
		retry: {
			retries: () => {
				throw new Error(error);
			}
		}
	}), error);
});
