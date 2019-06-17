import EventEmitter = require('events');
import test from 'ava';
import is from '@sindresorhus/is';
import pEvent = require('p-event');
import withServer from './helpers/with-server';

const retryAfterOn413 = 2;
const socketTimeout = 200;

const handler413 = (_request, response) => {
	response.writeHead(413, {
		'Retry-After': retryAfterOn413
	});
	response.end();
};

test('works on timeout error', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
		}
	});

	t.is((await got({timeout: {socket: socketTimeout}})).body, 'who`s there?');
});

test('setting to `0` disables retrying', withServer, async (t, server, got) => {
	let trys = 0;
	server.get('/', () => {
		trys++;
	});

	await t.throwsAsync(got({
		timeout: {socket: socketTimeout},
		retry: 0
	}), {
		instanceOf: got.TimeoutError,
		message: `Timeout awaiting 'socket' for ${socketTimeout}ms`
	});
	t.is(trys, 1);
});

test('retry function gets iteration count', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
		}
	});

	await got({
		timeout: {socket: socketTimeout},
		retry: {
			retries: iteration => {
				t.true(is.number(iteration));
				return iteration < 2;
			}
		}
	});
});

test('falsy value prevents retries', withServer, async (t, server, got) => {
	server.get('/', () => {});

	await t.throwsAsync(got({
		timeout: {socket: socketTimeout},
		retry: {
			retries: (iteration, error) => {
				t.true(is.error(error));
				t.is(iteration, 1);
				return 0;
			}
		}
	}), {
		instanceOf: got.TimeoutError,
		message: `Timeout awaiting 'socket' for ${socketTimeout}ms`
	});
});

test('custom retries', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let tried = false;
	const error = await t.throwsAsync(got({
		throwHttpErrors: true,
		retry: {
			retries: iteration => {
				if (iteration === 1) {
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
	t.is(error.response.statusCode, 500);
	t.true(tried);
});

test('custom error codes', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	const errorCode = 'OH_SNAP';

	const error = await t.throwsAsync(got({
		request: () => {
			const emitter = (new EventEmitter()) as any;
			emitter.end = () => {};

			const error = new Error('Snap!');
			// @ts-ignore
			error.code = errorCode;
			setTimeout(() => emitter.emit('error', error));

			return emitter;
		},
		retry: {
			retries: (_iteration, error) => {
				t.is(error.code, errorCode);
				return 0;
			},
			methods: [
				'GET'
			],
			errorCodes: [
				errorCode
			]
		}
	}));

	// @ts-ignore
	t.is(error.code, errorCode);
});

test('respects 413 Retry-After', withServer, async (t, server, got) => {
	let lastTried413access = Date.now();
	server.get('/', (_request, response) => {
		response.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		response.end((Date.now() - lastTried413access).toString());

		lastTried413access = Date.now();
	});

	const {statusCode, body} = await got({
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Number(body) >= retryAfterOn413 * 1000);
});

test('respects 413 Retry-After with RFC-1123 timestamp', withServer, async (t, server, got) => {
	let lastTried413TimestampAccess;
	server.get('/', (_request, response) => {
		const date = (new Date(Date.now() + (retryAfterOn413 * 1000))).toUTCString();

		response.writeHead(413, {
			'Retry-After': date
		});
		response.end(lastTried413TimestampAccess);
		lastTried413TimestampAccess = date;
	});

	const {statusCode, body} = await got({
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Date.now() >= Date.parse(body));
});

test('doesn\'t retry on 413 with empty statusCodes and methods', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
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
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
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
	server.get('/', (_request, response) => {
		response.statusCode = 413;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retries on 503 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.end();
	});

	const {retryCount} = await got({
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
	server.get('/', handler413);

	const {retryCount} = await got({
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('doesn\'t retry when set to false', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: false
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('works when defaults.options.retry is not an object', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const instance = got.extend({
		retry: 2
	});

	const {retryCount} = await instance({
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retry function can throw', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const error = 'Simple error';
	await t.throwsAsync(got({
		retry: {
			retries: () => {
				throw new Error(error);
			}
		}
	}), error);
});
