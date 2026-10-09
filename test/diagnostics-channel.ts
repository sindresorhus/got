import diagnosticsChannel from 'node:diagnostics_channel';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {Readable} from 'node:stream';
import {Buffer} from 'node:buffer';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import getStream from 'get-stream';
import {expectTypeOf} from 'expect-type';
import type {Handler} from 'express';
import got, {RequestError, type DiagnosticRequestError, type DiagnosticRequestRetry} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

function captureRequestDiagnostics(t: TestContext, url: string) {
	const events: Array<{requestId: string; channel: string; error?: Error}> = [];
	const channels = ['got:request:create', 'got:request:start', 'got:response:start', 'got:response:end', 'got:request:retry', 'got:request:error'];
	const handler = (message: unknown, channel: string | symbol) => {
		const event = message as {url?: string; requestId: string; error?: RequestError};
		if ((event.url ?? event.error?.options.url?.toString()) === url) {
			events.push({requestId: event.requestId, channel: String(channel), error: event.error});
		}
	};

	for (const channel of channels) {
		diagnosticsChannel.subscribe(channel, handler);
	}

	t.after(() => {
		for (const channel of channels) {
			diagnosticsChannel.unsubscribe(channel, handler);
		}
	});

	return events;
}

const echoHeaders: Handler = (request, response) => {
	request.resume();
	response.end(JSON.stringify(request.headers));
};

test('diagnostics channel - request:create event', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:request:create');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.url === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		await got('');

		assert.strictEqual(events.length, 1);
		const event = events[0];
		assert.ok(event.requestId);
		assert.strictEqual(typeof event.url, 'string');
		assert.strictEqual(event.method, 'GET');
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:start event', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:request:start');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.url === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		await got('');

		assert.strictEqual(events.length, 1);
		const event = events[0];
		assert.ok(event.requestId);
		assert.strictEqual(typeof event.url, 'string');
		assert.strictEqual(event.method, 'GET');
		assert.ok(event.headers);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request URLs are sanitized', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const createEvents: any[] = [];
	const startEvents: any[] = [];
	const createChannel = diagnosticsChannel.channel('got:request:create');
	const startChannel = diagnosticsChannel.channel('got:request:start');

	const createHandler = (message: any) => {
		if (message.method === 'GET') {
			createEvents.push(message);
		}
	};

	const startHandler = (message: any) => {
		if (message.method === 'GET') {
			startEvents.push(message);
		}
	};

	createChannel.subscribe(createHandler);
	startChannel.subscribe(startHandler);

	try {
		const url = new URL(server.url);
		url.username = 'user';
		url.password = 'secret';
		const expectedUrl = `${server.url}/`;
		await got(url);

		assert.strictEqual(createEvents.length > 0, true);
		assert.strictEqual(startEvents.length > 0, true);
		assert.strictEqual(createEvents.some(event => event.url === expectedUrl), true);
		assert.strictEqual(startEvents.some(event => event.url === expectedUrl), true);
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `includes` returns a boolean; the events are `any`-typed.
		assert.strictEqual(createEvents.some(event => event.url.includes('user') || event.url.includes('secret')), false);
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `includes` returns a boolean; the events are `any`-typed.
		assert.strictEqual(startEvents.some(event => event.url.includes('user') || event.url.includes('secret')), false);
	} finally {
		createChannel.unsubscribe(createHandler);
		startChannel.unsubscribe(startHandler);
	}
});

test('diagnostics channel - response:start event', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:response:start');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.url === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		await got('');

		assert.strictEqual(events.length, 1);
		const event = events[0];
		assert.ok(event.requestId);
		assert.strictEqual(event.statusCode, 200);
		assert.ok(event.headers);
		assert.strictEqual(typeof event.url, 'string');
		assert.strictEqual(event.isFromCache, false);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - response:end event', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:response:end');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.url === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		await got('');

		assert.strictEqual(events.length, 1);
		const event = events[0];
		assert.ok(event.requestId);
		assert.strictEqual(event.statusCode, 200);
		assert.strictEqual(typeof event.bodySize, 'number');
		assert.ok(event.timings);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:error event', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('error');
	});

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:request:error');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.url === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		await assert.rejects(got(''));

		assert.strictEqual(events.length, 1);
		const event = events[0];
		assert.ok(event.requestId);
		assert.ok(event.error);
		assert.strictEqual(typeof event.url, 'string');
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:error URL is sanitized', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('error');
	});

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:request:error');

	const handler = (message: any) => {
		if (message.url === `${server.url}/`) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		const url = new URL(server.url);
		url.username = 'user';
		url.password = 'secret';
		await assert.rejects(got(url, {
			retry: {
				limit: 0,
			},
		}));

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].url, `${server.url}/`);
		assert.strictEqual(events[0].url.includes('user'), false);
		assert.strictEqual(events[0].url.includes('secret'), false);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:retry event', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('error');
	});

	const events: any[] = [];
	const retryChannel = diagnosticsChannel.channel('got:request:retry');
	const createChannel = diagnosticsChannel.channel('got:request:create');
	const testUrl = `${server.url}/`;
	let testRequestId: string | undefined;

	const createHandler = (message: any) => {
		if (message.url === testUrl) {
			testRequestId = message.requestId;
		}
	};

	const retryHandler = (message: any) => {
		if (testRequestId && message.requestId === testRequestId) {
			events.push(message);
		}
	};

	createChannel.subscribe(createHandler);
	retryChannel.subscribe(retryHandler);

	try {
		await assert.rejects(got('', {
			retry: {
				limit: 2,
			},
		}));

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0].retryCount, 1);
		assert.strictEqual(events[1].retryCount, 2);
		assert.ok(events[0].error);
		assert.ok(events[1].error);
		assert.strictEqual(typeof events[0].delay, 'number');
		assert.strictEqual(typeof events[1].delay, 'number');
	} finally {
		createChannel.unsubscribe(createHandler);
		retryChannel.unsubscribe(retryHandler);
	}
});

test('diagnostics channel - response:redirect event', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		const redirectUrl = new URL(`${server.url}/redirect`);
		redirectUrl.username = 'redirect-user';
		redirectUrl.password = 'redirect-secret';

		response.writeHead(302, {
			location: redirectUrl.href,
		});
		response.end();
	});

	server.get('/redirect', echoHeaders);

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:response:redirect');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.fromUrl === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		const url = new URL(server.url);
		url.username = 'user';
		url.password = 'secret';
		await got(url);

		assert.strictEqual(events.length, 1);
		const event = events[0];
		assert.ok(event.requestId);
		assert.strictEqual(event.fromUrl, testUrl);
		assert.strictEqual(event.toUrl, `${server.url}/redirect`);
		assert.strictEqual(event.fromUrl.includes('user'), false);
		assert.strictEqual(event.fromUrl.includes('secret'), false);
		assert.strictEqual(event.toUrl.includes('redirect-user'), false);
		assert.strictEqual(event.toUrl.includes('redirect-secret'), false);
		assert.strictEqual(event.statusCode, 302);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - all events have consistent requestId', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	const requestIds = new Set<string>();
	const handlers: Array<{channel: any; handler: (message: any) => void}> = [];
	const testUrl = `${server.url}/`;

	const channels = [
		'got:request:create',
		'got:request:start',
		'got:response:start',
		'got:response:end',
	];

	for (const channelName of channels) {
		const channel = diagnosticsChannel.channel(channelName);
		const handler = (message: any) => {
			if (message.url === testUrl) {
				requestIds.add(message.requestId);
			}
		};

		channel.subscribe(handler);
		handlers.push({channel, handler});
	}

	try {
		await got('');

		assert.strictEqual(requestIds.size, 1);
	} finally {
		for (const {channel, handler} of handlers) {
			channel.unsubscribe(handler);
		}
	}
});

test('diagnostics channel - cache hit detection', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('ok');
	});

	const events: any[] = [];
	const channel = diagnosticsChannel.channel('got:response:start');
	const testUrl = `${server.url}/`;

	const handler = (message: any) => {
		if (message.url === testUrl) {
			events.push(message);
		}
	};

	channel.subscribe(handler);

	try {
		const cache = new Map();
		await got('', {cache});
		await got('', {cache});

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0].isFromCache, false);
		assert.strictEqual(events[1].isFromCache, true);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - no overhead when no subscribers', withServer, async (_t, server, got) => {
	server.get('/', echoHeaders);

	// Just verify it works without subscribers
	await got('');
});

test('diagnostics channel - automatic retries retain the original request ID', withServer, async (t, server, got) => {
	let attempts = 0;
	server.get('/', (_request, response) => {
		response.statusCode = ++attempts === 1 ? 503 : 200;
		response.end('response');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);

	const response = await got('', {retry: {limit: 1, calculateDelay: () => 1}});

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(attempts, 2);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:create').length, 2);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:retry').length, 1);
	assert.strictEqual(new Set(events.map(event => event.requestId)).size, 1);
});

test('diagnostics channel - exhausted retries retain the original request ID', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.end('unavailable');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);
	await assert.rejects(got('', {retry: {limit: 2, calculateDelay: ({computedValue}) => computedValue === 0 ? 0 : 1}}));

	assert.strictEqual(events.filter(event => event.channel === 'got:request:create').length, 3);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:retry').length, 2);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 1);
	assert.strictEqual(new Set(events.map(event => event.requestId)).size, 1);
});

test('diagnostics channel - hook retries retain the original request ID', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('response');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const response = await got('', {
		hooks: {
			afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({})],
		},
	});

	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:create').length, 2);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:retry').length, 1);
	assert.strictEqual(new Set(events.map(event => event.requestId)).size, 1);
});

test('diagnostics channel - independent concurrent requests have distinct IDs', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('response');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);
	await Promise.all([got(''), got('')]);

	const requestIds = events.filter(event => event.channel === 'got:request:create').map(event => event.requestId);
	assert.strictEqual(requestIds.length, 2);
	assert.notStrictEqual(requestIds[0], requestIds[1]);
	for (const requestId of requestIds) {
		assert.deepStrictEqual(events.filter(event => event.requestId === requestId).map(event => event.channel), [
			'got:request:create',
			'got:request:start',
			'got:response:start',
			'got:response:end',
		]);
	}
});

test('diagnostics channel - aborted requests publish a terminal error', withServer, async (t, server, got) => {
	const controller = new AbortController();
	server.get('/', () => {
		controller.abort(new Error('Cancelled by caller'));
	});
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	await assert.rejects(got('', {signal: controller.signal}), {code: 'ERR_ABORTED'});

	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 1);
	assert.strictEqual(new Set(events.map(event => event.requestId)).size, 1);
});

for (const streamMode of [false, true]) {
	test(`diagnostics channel - pre-aborted requests publish their exact error in stream mode ${streamMode}`, withServer, async (t, server, got) => {
		const events = captureRequestDiagnostics(t, `${server.url}/`);
		const cause = new Error('Already cancelled');
		const options = {signal: AbortSignal.abort(cause)};
		const request = streamMode ? getStream(got.stream('', options)) : got('', options);
		const error = await rejects(request, {code: 'ERR_ABORTED'});

		assert.deepStrictEqual(events.map(event => event.channel), ['got:request:create', 'got:request:error']);
		assert.strictEqual(events[1]?.error, error);
		assert.strictEqual(events[1]?.error?.cause, cause);
		assert.strictEqual(events[1]?.requestId, events[0]?.requestId);
	});
}

test('diagnostics channel - direct stream destruction publishes the normalized error', withServer, async (t, server, got) => {
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const cause = new Error('Stream failed');
	const request = got.stream('');
	const result = getStream(request);
	request.destroy(cause);
	const error = await rejects(result, {message: cause.message});

	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 1);
	assert.strictEqual(events.at(-1)?.error, error);
	assert.strictEqual(events.at(-1)?.error?.cause, cause);
});

test('diagnostics channel - stream destruction without an error does not report failure', withServer, async (t, server, got) => {
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const request = got.stream('');
	const closed = new Promise<void>(resolve => {
		request.once('close', resolve);
	});
	request.destroy();
	await closed;

	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 0);
});

test('diagnostics channel - error hooks publish their final replacement exactly once', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('failed');
	});
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const replacement = new TypeError('Application failure');
	const error = await rejects(got('', {
		retry: {limit: 0},
		hooks: {beforeError: [() => replacement]},
	}), TypeError);

	assert.strictEqual(error, replacement);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 1);
	assert.strictEqual(events.at(-1)?.error, replacement);
});

test('diagnostics channel - errors emitted after request cleanup remain observable', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('failed');
	});
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const error = await rejects(got('', {
		retry: {limit: 0},
		hooks: {
			beforeError: [error => {
				error.request!.destroy();
				return error;
			}],
		},
	}), {code: 'ERR_NON_2XX_3XX_RESPONSE'});

	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 1);
	assert.strictEqual(events.at(-1)?.error, error);
});

test('diagnostic terminal error types accept ordinary errors returned by hooks', _t => {
	expectTypeOf<DiagnosticRequestError['error']>().toEqualTypeOf<Error>();
	expectTypeOf<DiagnosticRequestRetry['error']>().toEqualTypeOf<RequestError>();
	const error = new TypeError('Application failure');
	const message: DiagnosticRequestError = {requestId: 'request', url: 'https://example.com/', error};

	assert.strictEqual(message.error, error);
	// @ts-expect-error Terminal errors need narrowing before accessing Got-specific properties.
	const requestOptions: unknown = message.error.options;
	assert.strictEqual(requestOptions, undefined);
});

for (const replaceError of [false, true]) {
	test(`diagnostic subscribers can narrow terminal errors with replacement ${replaceError}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = 500;
			response.end('failed');
		});
		const replacement = new TypeError('Application failure');
		const errors: Error[] = [];
		const listener = (value: unknown) => {
			const message = value as DiagnosticRequestError;
			if (message.url !== `${server.url}/`) {
				return;
			}

			errors.push(message.error);
			if (message.error instanceof RequestError) {
				expectTypeOf(message.error.options).toEqualTypeOf<RequestError['options']>();
				assert.strictEqual(message.error.options.method, 'GET');
				assert.strictEqual(message.error.code, 'ERR_NON_2XX_3XX_RESPONSE');
				assert.strictEqual(replaceError, false);
			} else {
				expectTypeOf(message.error).toEqualTypeOf<Error>();
				assert.strictEqual(message.error, replacement);
				assert.strictEqual(replaceError, true);
			}
		};

		diagnosticsChannel.subscribe('got:request:error', listener);
		t.after(() => {
			diagnosticsChannel.unsubscribe('got:request:error', listener);
		});

		const error = await rejects(got('', {
			retry: {limit: 0},
			hooks: {beforeError: [error => replaceError ? replacement : error]},
		}));

		assert.deepStrictEqual(errors, [error]);
	});
}

test('diagnostics reports the final error after a writable callback failure', withServer, async (t, server, got) => {
	const cause = Object.assign(new Error('write failed'), {code: 'EPIPE'});
	const replacement = new Error('application failure');
	const errors: Error[] = [];
	const listener = (message: any) => {
		if (message.url === `${server.url}/`) {
			errors.push(message.error);
		}
	};

	diagnosticsChannel.subscribe('got:request:error', listener);
	t.after(() => diagnosticsChannel.unsubscribe('got:request:error', listener));
	const error = await rejects(got.post('', {
		body: Readable.from(['payload']),
		retry: {limit: 0},
		hooks: {beforeError: [() => replacement]},
		request(url, options) {
			const request = http.request(url, options);
			request.write = ((_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
				queueMicrotask(() => {
					callback(cause);
				});
				return false;
			}) as typeof request.write;
			return request;
		},
	}), {message: replacement.message});
	assert.strictEqual(error, replacement);
	assert.strictEqual(errors.length, 1);
	assert.strictEqual(errors[0], replacement);
});

test('diagnostics do not report a terminal error for a recovered writable failure', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		request.pipe(response);
	});
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const cause = Object.assign(new Error('write failed'), {code: 'EPIPE'});
	let requests = 0;
	const response = await got.post('', {
		body: Readable.from(['payload']),
		retry: {
			limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0,
		},
		hooks: {
			beforeRetry: [error => {
				error.options.body = Readable.from(['recovered']);
			}],
		},
		request(url, options) {
			const request = http.request(url, options);
			if (++requests === 1) {
				request.write = ((_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
					queueMicrotask(() => {
						callback(cause);
					});
					return false;
				}) as typeof request.write;
			}

			return request;
		},
	});

	assert.strictEqual(response.body, 'recovered');
	assert.strictEqual(requests, 2);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:retry').length, 1);
	assert.strictEqual(events.filter(event => event.channel === 'got:request:error').length, 0);
});

test('diagnostics report outward writable errors in stream mode', withServer, async (t, server, got) => {
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const cause = Object.assign(new Error('write failed'), {code: 'EPIPE'});
	const stream = got.stream.post('', {
		retry: {limit: 0},
		request(url, options) {
			const request = http.request(url, options);
			// Socket cleanup can emit another native error after the simulated write failure.
			request.on('error', () => {});
			request.write = ((_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
				queueMicrotask(() => {
					callback(cause);
					request.emit('error', cause);
				});
				return false;
			}) as typeof request.write;
			return request;
		},
	});
	const outwardError = new Promise<Error>(resolve => {
		stream.once('error', resolve);
	});
	const closed = new Promise<void>(resolve => {
		stream.once('close', resolve);
	});
	stream.write('payload');
	const error = await outwardError;
	await closed;

	assert.strictEqual(error, cause);
	const errorEvents = events.filter(event => event.channel === 'got:request:error');
	assert.strictEqual(errorEvents.length, 1);
	assert.strictEqual(errorEvents[0]?.error, error);
});

// A diagnostics subscriber gets a message, not a handle on Got's internals.
test('a request:start subscriber cannot change the outgoing headers', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const subscription = diagnosticsChannel.channel('got:request:start');
	const handler = (message: any) => {
		message.headers['x-injected'] = 'yes';
		message.headers['user-agent'] = 'tampered';
	};

	subscription.subscribe(handler);
	t.after(() => {
		subscription.unsubscribe(handler);
	});

	const response = await got('');

	assert.strictEqual(response.request.options.headers['x-injected'], undefined);
	assert.strictEqual(response.request.options.headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
});

test('a response:start subscriber cannot change the response the caller receives', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('x-from-server', 'yes');
		response.end('ok');
	});

	const subscription = diagnosticsChannel.channel('got:response:start');
	const handler = (message: any) => {
		message.headers['x-mutated'] = 'yes';
	};

	subscription.subscribe(handler);
	t.after(() => {
		subscription.unsubscribe(handler);
	});

	const response = await got('');

	assert.strictEqual(response.headers['x-mutated'], undefined);
	assert.strictEqual(response.headers['x-from-server'], 'yes');
});

type CapturedDiagnostic = Record<string, any> & {channel: string; requestId: string};

/**
Records every Got diagnostic message of the request created for `url`, including redirect messages, which have no `url` field.
*/
function captureAllDiagnostics(t: TestContext, url: string): () => CapturedDiagnostic[] {
	const messages: CapturedDiagnostic[] = [];
	const channels = ['got:request:create', 'got:request:start', 'got:response:start', 'got:response:end', 'got:request:retry', 'got:request:error', 'got:response:redirect'];
	const handler = (message: unknown, channel: string | symbol) => {
		messages.push({...(message as Record<string, any>), channel: String(channel)} as CapturedDiagnostic);
	};

	for (const channel of channels) {
		diagnosticsChannel.subscribe(channel, handler);
	}

	t.after(() => {
		for (const channel of channels) {
			diagnosticsChannel.unsubscribe(channel, handler);
		}
	});

	return () => {
		const requestId = messages.find(message => message.channel === 'got:request:create' && message.url === url)?.requestId;
		return messages.filter(message => requestId !== undefined && message.requestId === requestId);
	};
}

test('diagnostics channel - a redirect publishes its events in order under one request ID', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		response.writeHead(303, {location: '/target?page=2'});
		response.end();
	});
	server.get('/target', (_request, response) => {
		response.end('target');
	});

	const getMessages = captureAllDiagnostics(t, `${server.url}/`);
	await got.post('', {body: 'payload'});

	const messages = getMessages();
	assert.deepStrictEqual(messages.map(message => message.channel), [
		'got:request:create',
		'got:request:start',
		'got:response:start',
		'got:response:redirect',
		'got:request:start',
		'got:response:start',
		'got:response:end',
	]);
	assert.deepStrictEqual(messages.filter(message => message.channel === 'got:request:start').map(message => [message.method, message.url]), [
		['POST', `${server.url}/`],
		['GET', `${server.url}/target?page=2`],
	]);
	assert.deepStrictEqual(messages.filter(message => message.channel === 'got:response:start').map(message => [message.statusCode, message.url]), [
		[303, `${server.url}/`],
		[200, `${server.url}/target?page=2`],
	]);
	assert.partialDeepStrictEqual(messages.find(message => message.channel === 'got:response:redirect'), {
		fromUrl: `${server.url}/`,
		toUrl: `${server.url}/target?page=2`,
		statusCode: 303,
	});
});

test('diagnostics channel - a refused connection publishes an error without response events', async t => {
	const server = http.createServer();
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const {port} = server.address() as AddressInfo;
	await new Promise<void>(resolve => {
		server.close(() => {
			resolve();
		});
	});

	const url = `http://127.0.0.1:${port}/`;
	const getMessages = captureAllDiagnostics(t, url);
	const error = await rejects(got(url, {retry: {limit: 0}}), {code: 'ECONNREFUSED'});

	const messages = getMessages();
	assert.deepStrictEqual(messages.map(message => message.channel), [
		'got:request:create',
		'got:request:start',
		'got:request:error',
	]);
	assert.strictEqual(messages[2]!.error, error);
	assert.strictEqual(messages[2]!.url, url);
});

for (const streamMode of [false, true]) {
	test(`diagnostics channel - response:end reports the exact body size in stream mode ${streamMode}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('héllo wörld');
		});

		const getMessages = captureAllDiagnostics(t, `${server.url}/`);
		if (streamMode) {
			await got.stream('').toArray();
		} else {
			await got('');
		}

		const end = getMessages().find(message => message.channel === 'got:response:end');
		assert.strictEqual(end?.bodySize, Buffer.byteLength('héllo wörld'));
		assert.strictEqual(end?.statusCode, 200);
		assert.strictEqual(end?.url, `${server.url}/`);
	});
}

test('diagnostics channel - request:retry reports the configured delay and the failure', withServer, async (t, server, got) => {
	let attempts = 0;
	server.get('/', (_request, response) => {
		attempts++;
		response.statusCode = attempts === 1 ? 503 : 200;
		response.end();
	});

	const getMessages = captureAllDiagnostics(t, `${server.url}/`);
	await got('', {
		retry: {
			limit: 1,
			calculateDelay: ({computedValue}) => computedValue === 0 ? 0 : 7,
		},
	});

	const retries = getMessages().filter(message => message.channel === 'got:request:retry');
	assert.strictEqual(retries.length, 1);
	assert.strictEqual(retries[0]!.delay, 7);
	assert.strictEqual(retries[0]!.retryCount, 1);
	assert.ok(retries[0]!.error instanceof RequestError);
	assert.strictEqual((retries[0]!.error as RequestError).response?.statusCode, 503);
});

test('diagnostics channel - request:start headers include beforeRequest hook changes', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const getMessages = captureAllDiagnostics(t, `${server.url}/`);
	await got('', {
		hooks: {
			beforeRequest: [
				options => {
					options.headers['x-from-hook'] = 'yes';
				},
			],
		},
	});

	const start = getMessages().find(message => message.channel === 'got:request:start');
	assert.strictEqual(start?.headers['x-from-hook'], 'yes');
});

test('diagnostics channel - HTTP/2 requests publish the full event set without pseudo-headers', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({':status': 200, 'x-h2': 'yes'});
		stream.end('ok');
	});
	t.after(async () => {
		await server.close();
	});

	const getMessages = captureAllDiagnostics(t, `${server.url}/`);
	await got(server.url, {http2: true, https: {rejectUnauthorized: false}});

	const messages = getMessages();
	assert.deepStrictEqual(messages.map(message => message.channel), [
		'got:request:create',
		'got:request:start',
		'got:response:start',
		'got:response:end',
	]);
	const responseStart = messages[2]!;
	assert.strictEqual(responseStart.statusCode, 200);
	assert.strictEqual(responseStart.headers['x-h2'], 'yes');
	assert.strictEqual(Object.keys(responseStart.headers).some(name => name.startsWith(':')), false);
	assert.strictEqual(messages[3]!.bodySize, 2);
});
