import diagnosticsChannel from 'node:diagnostics_channel';
import http from 'node:http';
import {Readable} from 'node:stream';
import test, {type ExecutionContext} from 'ava';
import getStream from 'get-stream';
import {expectTypeOf} from 'expect-type';
import type {Handler} from 'express';
import {RequestError, type DiagnosticRequestError, type DiagnosticRequestRetry} from '../source/index.js';
import withServer from './helpers/with-server.js';

function captureRequestDiagnostics(t: ExecutionContext, url: string) {
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

	t.teardown(() => {
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

test('diagnostics channel - request:create event', withServer, async (t, server, got) => {
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

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.is(typeof event.url, 'string');
		t.is(event.method, 'GET');
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:start event', withServer, async (t, server, got) => {
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

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.is(typeof event.url, 'string');
		t.is(event.method, 'GET');
		t.truthy(event.headers);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request URLs are sanitized', withServer, async (t, server, got) => {
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

		t.true(createEvents.length > 0);
		t.true(startEvents.length > 0);
		t.true(createEvents.some(event => event.url === expectedUrl));
		t.true(startEvents.some(event => event.url === expectedUrl));
		t.false(createEvents.some(event => event.url.includes('user')) || createEvents.some(event => event.url.includes('secret')));
		t.false(startEvents.some(event => event.url.includes('user')) || startEvents.some(event => event.url.includes('secret')));
	} finally {
		createChannel.unsubscribe(createHandler);
		startChannel.unsubscribe(startHandler);
	}
});

test('diagnostics channel - response:start event', withServer, async (t, server, got) => {
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

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.is(event.statusCode, 200);
		t.truthy(event.headers);
		t.is(typeof event.url, 'string');
		t.false(event.isFromCache);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - response:end event', withServer, async (t, server, got) => {
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

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.is(event.statusCode, 200);
		t.is(typeof event.bodySize, 'number');
		t.truthy(event.timings);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:error event', withServer, async (t, server, got) => {
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
		await t.throwsAsync(got(''));

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.truthy(event.error);
		t.is(typeof event.url, 'string');
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:error URL is sanitized', withServer, async (t, server, got) => {
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

		await t.throwsAsync(got(url, {
			retry: {
				limit: 0,
			},
		}));

		t.is(events.length, 1);
		t.is(events[0].url, `${server.url}/`);
		t.false(events[0].url.includes('user'));
		t.false(events[0].url.includes('secret'));
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - request:retry event', withServer, async (t, server, got) => {
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
		await t.throwsAsync(got('', {
			retry: {
				limit: 2,
			},
		}));

		t.is(events.length, 2);
		t.is(events[0].retryCount, 1);
		t.is(events[1].retryCount, 2);
		t.truthy(events[0].error);
		t.truthy(events[1].error);
		t.is(typeof events[0].delay, 'number');
		t.is(typeof events[1].delay, 'number');
	} finally {
		createChannel.unsubscribe(createHandler);
		retryChannel.unsubscribe(retryHandler);
	}
});

test('diagnostics channel - response:redirect event', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		const redirectUrl = new URL(`${server.url}/redirect`);
		redirectUrl.username = 'redirect-user';
		redirectUrl.password = 'redirect-secret';

		response.writeHead(302, {
			location: redirectUrl.toString(),
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

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.is(event.fromUrl, testUrl);
		t.is(event.toUrl, `${server.url}/redirect`);
		t.false(event.fromUrl.includes('user'));
		t.false(event.fromUrl.includes('secret'));
		t.false(event.toUrl.includes('redirect-user'));
		t.false(event.toUrl.includes('redirect-secret'));
		t.is(event.statusCode, 302);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - all events have consistent requestId', withServer, async (t, server, got) => {
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

		t.is(requestIds.size, 1);
	} finally {
		for (const {channel, handler} of handlers) {
			channel.unsubscribe(handler);
		}
	}
});

test('diagnostics channel - cache hit detection', withServer, async (t, server, got) => {
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

		t.is(events.length, 2);
		t.false(events[0].isFromCache);
		t.true(events[1].isFromCache);
	} finally {
		channel.unsubscribe(handler);
	}
});

test('diagnostics channel - no overhead when no subscribers', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	// Just verify it works without subscribers
	await got('');

	t.pass();
});

test('diagnostics channel - automatic retries retain the original request ID', withServer, async (t, server, got) => {
	let attempts = 0;
	server.get('/', (_request, response) => {
		response.statusCode = ++attempts === 1 ? 503 : 200;
		response.end('response');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);

	const response = await got('', {retry: {limit: 1, calculateDelay: () => 1}});

	t.is(response.statusCode, 200);
	t.is(attempts, 2);
	t.is(events.filter(event => event.channel === 'got:request:create').length, 2);
	t.is(events.filter(event => event.channel === 'got:request:retry').length, 1);
	t.is(new Set(events.map(event => event.requestId)).size, 1);
});

test('diagnostics channel - exhausted retries retain the original request ID', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.end('unavailable');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);
	await t.throwsAsync(got('', {retry: {limit: 2, calculateDelay: ({computedValue}) => computedValue === 0 ? 0 : 1}}));

	t.is(events.filter(event => event.channel === 'got:request:create').length, 3);
	t.is(events.filter(event => event.channel === 'got:request:retry').length, 2);
	t.is(events.filter(event => event.channel === 'got:request:error').length, 1);
	t.is(new Set(events.map(event => event.requestId)).size, 1);
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

	t.is(response.retryCount, 1);
	t.is(events.filter(event => event.channel === 'got:request:create').length, 2);
	t.is(events.filter(event => event.channel === 'got:request:retry').length, 1);
	t.is(new Set(events.map(event => event.requestId)).size, 1);
});

test('diagnostics channel - independent concurrent requests have distinct IDs', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('response');
	});

	const events = captureRequestDiagnostics(t, `${server.url}/`);
	await Promise.all([got(''), got('')]);

	const requestIds = events.filter(event => event.channel === 'got:request:create').map(event => event.requestId);
	t.is(requestIds.length, 2);
	t.not(requestIds[0], requestIds[1]);
	for (const requestId of requestIds) {
		t.deepEqual(events.filter(event => event.requestId === requestId).map(event => event.channel), [
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

	await t.throwsAsync(got('', {signal: controller.signal}), {code: 'ERR_ABORTED'});

	t.is(events.filter(event => event.channel === 'got:request:error').length, 1);
	t.is(new Set(events.map(event => event.requestId)).size, 1);
});

for (const streamMode of [false, true]) {
	test(`diagnostics channel - pre-aborted requests publish their exact error in stream mode ${streamMode}`, withServer, async (t, server, got) => {
		const events = captureRequestDiagnostics(t, `${server.url}/`);
		const cause = new Error('Already cancelled');
		const options = {signal: AbortSignal.abort(cause)};
		const request = streamMode ? getStream(got.stream('', options)) : got('', options);
		const error = await t.throwsAsync(request, {code: 'ERR_ABORTED'});

		t.deepEqual(events.map(event => event.channel), ['got:request:create', 'got:request:error']);
		t.is(events[1]?.error, error);
		t.is(events[1]?.error?.cause, cause);
		t.is(events[1]?.requestId, events[0]?.requestId);
	});
}

test('diagnostics channel - direct stream destruction publishes the normalized error', withServer, async (t, server, got) => {
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const cause = new Error('Stream failed');
	const request = got.stream('');
	const result = getStream(request);
	request.destroy(cause);
	const error = await t.throwsAsync(result, {message: cause.message});

	t.is(events.filter(event => event.channel === 'got:request:error').length, 1);
	t.is(events.at(-1)?.error, error);
	t.is(events.at(-1)?.error?.cause, cause);
});

test('diagnostics channel - stream destruction without an error does not report failure', withServer, async (t, server, got) => {
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const request = got.stream('');
	const closed = new Promise<void>(resolve => {
		request.once('close', resolve);
	});
	request.destroy();
	await closed;

	t.is(events.filter(event => event.channel === 'got:request:error').length, 0);
});

test('diagnostics channel - error hooks publish their final replacement exactly once', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('failed');
	});
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const replacement = new TypeError('Application failure');
	const error = await t.throwsAsync(got('', {
		retry: {limit: 0},
		hooks: {beforeError: [() => replacement]},
	}), {instanceOf: TypeError});

	t.is(error, replacement);
	t.is(events.filter(event => event.channel === 'got:request:error').length, 1);
	t.is(events.at(-1)?.error, replacement);
});

test('diagnostics channel - errors emitted after request cleanup remain observable', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('failed');
	});
	const events = captureRequestDiagnostics(t, `${server.url}/`);
	const error = await t.throwsAsync(got('', {
		retry: {limit: 0},
		hooks: {
			beforeError: [error => {
				error.request!.destroy();
				return error;
			}],
		},
	}), {code: 'ERR_NON_2XX_3XX_RESPONSE'});

	t.is(events.filter(event => event.channel === 'got:request:error').length, 1);
	t.is(events.at(-1)?.error, error);
});

test('diagnostic terminal error types accept ordinary errors returned by hooks', t => {
	expectTypeOf<DiagnosticRequestError['error']>().toEqualTypeOf<Error>();
	expectTypeOf<DiagnosticRequestRetry['error']>().toEqualTypeOf<RequestError>();
	const error = new TypeError('Application failure');
	const message: DiagnosticRequestError = {requestId: 'request', url: 'https://example.com/', error};

	t.is(message.error, error);
	// @ts-expect-error Terminal errors need narrowing before accessing Got-specific properties.
	const requestOptions: unknown = message.error.options;
	t.is(requestOptions, undefined);
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
				t.is(message.error.options.method, 'GET');
				t.is(message.error.code, 'ERR_NON_2XX_3XX_RESPONSE');
				t.false(replaceError);
			} else {
				expectTypeOf(message.error).toEqualTypeOf<Error>();
				t.is(message.error, replacement);
				t.true(replaceError);
			}
		};

		diagnosticsChannel.subscribe('got:request:error', listener);
		t.teardown(() => {
			diagnosticsChannel.unsubscribe('got:request:error', listener);
		});

		const error = await t.throwsAsync(got('', {
			retry: {limit: 0},
			hooks: {beforeError: [error => replaceError ? replacement : error]},
		}));

		t.deepEqual(errors, [error]);
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
	t.teardown(() => diagnosticsChannel.unsubscribe('got:request:error', listener));
	const error = await t.throwsAsync(got.post('', {
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
	t.is(error, replacement);
	t.is(errors.length, 1);
	t.is(errors[0], replacement);
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

	t.is(response.body, 'recovered');
	t.is(requests, 2);
	t.is(events.filter(event => event.channel === 'got:request:retry').length, 1);
	t.is(events.filter(event => event.channel === 'got:request:error').length, 0);
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

	t.is(error, cause);
	const errorEvents = events.filter(event => event.channel === 'got:request:error');
	t.is(errorEvents.length, 1);
	t.is(errorEvents[0]?.error, error);
});
