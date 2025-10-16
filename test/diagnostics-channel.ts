import diagnosticsChannel from 'node:diagnostics_channel';
import test from 'ava';
import type {Handler} from 'express';
import withServer from './helpers/with-server.js';

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
		t.is(event.isFromCache, false);
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
		response.writeHead(302, {
			location: '/redirect',
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
		await got('');

		t.is(events.length, 1);
		const event = events[0];
		t.truthy(event.requestId);
		t.is(typeof event.fromUrl, 'string');
		t.is(typeof event.toUrl, 'string');
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
		t.is(events[0].isFromCache, false);
		t.is(events[1].isFromCache, true);
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
