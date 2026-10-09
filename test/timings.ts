import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {PassThrough} from 'node:stream';
import {promises as dnsPromises} from 'node:dns';
import {expectTypeOf} from 'expect-type';
import getStream from 'get-stream';
import got, {HTTPError, RequestError, TimeoutError} from '../source/index.js';
import DnsCache from '../source/core/utils/dns-cache.js';
import type {Timings} from '../source/core/utils/timer.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import withServer, {withHttpsServer} from './helpers/with-server.js';

test('http/1 timings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {timings} = await got('');
	assert.ok(timings !== undefined);

	assert.strictEqual(timings.start >= 0, true);
	assert.strictEqual(timings.socket! >= 0, true);
	assert.strictEqual(timings.lookup! >= 0, true);
	assert.strictEqual(timings.connect! >= 0, true);
	assert.strictEqual(timings.upload! >= 0, true);
	assert.strictEqual(timings.response! >= 0, true);
	assert.strictEqual(timings.end! >= 0, true);

	const {phases} = timings;

	assert.strictEqual(phases.wait! >= 0, true);
	assert.strictEqual(phases.dns! >= 0, true);
	assert.strictEqual(phases.tcp! >= 0, true);
	assert.strictEqual(phases.request! >= 0, true);
	assert.strictEqual(phases.firstByte! >= 0, true);
	assert.strictEqual(phases.download! >= 0, true);
	assert.strictEqual(phases.total! >= 0, true);
});

test('http/2 timings', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const {timings} = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		assert.ok(timings !== undefined);

		// These timings are available even for HTTP/2
		assert.strictEqual(timings.start >= 0, true);
		assert.strictEqual(timings.socket! >= 0, true);
		assert.strictEqual(timings.upload! >= 0, true);
		assert.strictEqual(timings.response! >= 0, true);
		assert.strictEqual(timings.end! >= 0, true);

		// These connection timings are unavailable for HTTP/2 (socket is a proxy)
		// See https://github.com/sindresorhus/got/issues/1958
		assert.strictEqual(timings.lookup, undefined);
		assert.strictEqual(timings.connect, undefined);
		assert.strictEqual(timings.secureConnect, undefined);

		const {phases} = timings;

		// Available phases
		assert.strictEqual(phases.wait! >= 0, true);
		assert.strictEqual(phases.firstByte! >= 0, true);
		assert.strictEqual(phases.download! >= 0, true);
		assert.strictEqual(phases.total! >= 0, true);

		// Unavailable phases (due to missing connection timings)
		assert.strictEqual(phases.dns, undefined);
		assert.strictEqual(phases.tcp, undefined);
		assert.strictEqual(phases.tls, undefined);
		// Most importantly: phases.request should be undefined, NOT NaN
		assert.strictEqual(phases.request, undefined);
		assert.strictEqual(Number.isNaN(phases.request), false);
	} finally {
		await server.close();
	}
});

test('timings.end is set when stream is destroyed before completion', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('chunk1');
		// Don't end the response, so it stays open
	});
	await new Promise<void>((resolve, reject) => {
		const stream = got.stream('');

		stream.on('data', () => {
			stream.destroy(new Error('Manual destroy'));
		});

		stream.on('error', (error: Error) => {
			assert.strictEqual(error.message, 'Manual destroy');
			assert.ok(stream.timings);
			assert.ok(stream.timings.response);
			assert.ok(stream.timings.end);
			assert.strictEqual(stream.timings.end >= stream.timings.response, true);
			assert.ok(stream.timings.phases.total);
			resolve();
		});

		stream.on('end', () => {
			reject(new Error('Stream should not end normally'));
		});
	});
});

test('firstByte is undefined when the response arrives before the upload finishes', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		// Respond without consuming the request body, like a server rejecting an upload early.
		response.end('rejected');
	});

	const body = new PassThrough();
	// Node.js sends the request headers with the first body chunk, so write one and keep the stream open.
	body.write('partial');
	await new Promise<void>((resolve, reject) => {
		const stream = got.stream.post('', {body});

		stream.on('response', response => {
			const {timings} = response;
			assert.strictEqual(timings.upload, undefined);
			assert.strictEqual(timings.phases.firstByte, undefined);
			stream.destroy();
			resolve();
		});

		stream.on('error', reject);
	});

	body.end();
});

test('dns timing is 0 for IP addresses', withServer, async (_t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// Get the actual IP address the server is bound to
	const address = server.http.address() as {address: string; family: string; port: number};
	const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
	const {timings} = await got(`http://${host}:${server.port}/`);
	assert.ok(timings !== undefined);

	// When connecting to an IP address, there is no DNS lookup
	assert.strictEqual(timings.phases.dns, 0);
	// Lookup timestamp should equal socket timestamp (no time elapsed for DNS)
	assert.strictEqual(timings.lookup, timings.socket);
});

test('cached DNS lookups reuse resolved addresses in timing requests', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let resolve4CallCount = 0;
	let resolve6CallCount = 0;
	const serverAddress = server.http.address() as {family: string};
	const isIpv6Server = serverAddress.family === 'IPv6';

	const resolver = new dnsPromises.Resolver();
	resolver.resolve4 = (async (_hostname: string, _options: unknown) => {
		resolve4CallCount++;
		return isIpv6Server ? [] : [{address: '127.0.0.1', ttl: 60}];
	}) as typeof resolver.resolve4;
	resolver.resolve6 = (async (_hostname: string, _options: unknown) => {
		resolve6CallCount++;
		return isIpv6Server ? [{address: '::1', ttl: 60}] : [];
	}) as typeof resolver.resolve6;

	// Enable DNS cache and disable keep-alive to get new connections
	const instance = got.extend({
		dnsCache: new DnsCache({resolver, errorTtl: 60}),
		agent: {
			http: new http.Agent({
				keepAlive: false,
			}),
		},
	});

	const responses = [
		await instance(''),
		await instance(''),
		await instance(''),
	];

	assert.strictEqual(resolve4CallCount, 1);
	assert.strictEqual(resolve6CallCount, 1);

	for (const {timings} of responses) {
		assert.ok(timings !== undefined);
		assert.strictEqual(Number.isFinite(timings.socket), true);
		assert.strictEqual(Number.isFinite(timings.lookup), true);
		assert.strictEqual(Number.isFinite(timings.connect), true);
		assert.strictEqual(Number.isFinite(timings.phases.dns), true);
		assert.strictEqual(timings.phases.dns! >= 0, true);
		assert.strictEqual(timings.lookup! >= timings.socket!, true);
		assert.strictEqual(timings.connect! >= timings.lookup!, true);
	}
});

test('redirect timings preserve connection timings from initial request', withServer, async (_t, server, got) => {
	// Set up a redirect chain to test socket reuse scenario
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: '/redirect1',
		});
		response.end();
	});

	server.get('/redirect1', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', (_request, response) => {
		response.end('final content');
	});

	const response = await got('');
	const {timings} = response;
	assert.ok(timings !== undefined);

	// Verify the response went through redirects
	assert.strictEqual(response.redirectUrls.length, 2);
	assert.strictEqual(response.body, 'final content');

	// The bug (#2425) was that on redirects with socket reuse, all timestamps
	// were set to socket time, causing all phases to be 0.

	// After the fix, for reused sockets:
	// - Timestamps are still all at socket time (correct for reused sockets)
	// - But phases preserve the original connection durations (not 0)

	// Verify timestamps are at socket time for reused socket
	assert.strictEqual(timings.lookup, timings.socket);
	assert.strictEqual(timings.connect, timings.socket);

	// Verify phases are preserved (not all 0)
	// For localhost, dns is 0 (IP address), but tcp should have some value
	assert.strictEqual(typeof timings.phases.dns, 'number');
	assert.strictEqual(typeof timings.phases.tcp, 'number');
	assert.strictEqual(timings.phases.dns! >= 0, true);
	assert.strictEqual(timings.phases.tcp! >= 0, true);

	// Verify basic timing chronology
	assert.strictEqual(timings.start <= timings.socket!, true);
	assert.strictEqual(timings.socket! <= timings.response!, true);
	assert.strictEqual(timings.response! <= timings.end!, true);
});

test('https timings record the TLS phase and keep it on a reused socket', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const agent = new https.Agent({keepAlive: true});
	t.after(() => {
		agent.destroy();
	});

	const first = (await got('', {agent: {https: agent}})).timings;
	const second = (await got('', {agent: {https: agent}})).timings;
	assert.ok(first);
	assert.ok(second);

	assert.strictEqual(typeof first.secureConnect, 'number');
	assert.strictEqual(first.phases.tls, first.secureConnect! - first.connect!);

	// The second request reuses the socket, so it has no handshake of its own but keeps the phase of the first.
	assert.strictEqual(second.connect, second.socket);
	assert.strictEqual(second.secureConnect, second.socket);
	assert.strictEqual(second.phases.tls, first.phases.tls);
});

test('cached responses can omit network timings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('cached content');
	});
	const cache = new Map();
	const first = await got('', {cache});
	const cached = await got('', {cache});

	assert.ok(first.timings);
	assert.strictEqual(cached.isFromCache, true);
	// The type check comes first: `assert.strictEqual` narrows to `undefined`, which would leave
	// `expectTypeOf` asserting against the narrowed type instead of the declared one.
	expectTypeOf(cached.timings).toEqualTypeOf<Timings | undefined>();
	assert.strictEqual(cached.timings, undefined);
});

for (const useHook of [false, true]) {
	test(`native responses can omit network timings with beforeRequest=${useHook}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('native content');
		});
		const makeResponse = async () => new Promise<http.IncomingMessage>((resolve, reject) => {
			http.get(server.url, resolve).once('error', reject);
		});
		const response = await got('', useHook ? {hooks: {beforeRequest: [makeResponse]}} : {request: makeResponse});

		assert.strictEqual(response.body, 'native content');
		expectTypeOf(response.timings).toEqualTypeOf<Timings | undefined>();
		assert.strictEqual(response.timings, undefined);
	});
}

test('HTTP errors from native responses can omit network timings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.status(400).end('native error');
	});
	const error = await rejects<HTTPError>(got('', {
		request: async () => new Promise<http.IncomingMessage>((resolve, reject) => {
			http.get(server.url, resolve).once('error', reject);
		}),
	}), HTTPError);

	expectTypeOf(error.timings).toEqualTypeOf<Timings | undefined>();
	assert.strictEqual(error.timings, undefined);
	assert.strictEqual(error.response.body, 'native error');
});

test('a connection reset before the response exposes timings that end at the error', withServer, async (_t, server, got) => {
	server.get('/', request => {
		request.socket.destroy();
	});

	const error = await rejects<RequestError>(got('', {retry: {limit: 0}}), errorMatching(RequestError, {code: 'ECONNRESET'}));
	const {timings} = error;

	assert.ok(timings);
	assert.strictEqual(timings, error.request?.timings);
	assert.strictEqual(timings.response, undefined);
	assert.strictEqual(timings.end, undefined);
	assert.strictEqual(timings.phases.firstByte, undefined);
	assert.strictEqual(timings.phases.total, timings.error! - timings.start);
});

test('a read timeout exposes timings with a first byte but no download', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-length': '100'});
		response.write('partial');
	});

	const error = await rejects<TimeoutError>(got('', {timeout: {read: 100}, retry: {limit: 0}}), errorMatching(TimeoutError, {event: 'read'}));
	const {timings} = error;

	assert.strictEqual(timings, error.request.timings);
	assert.strictEqual(timings.end, undefined);
	assert.strictEqual(timings.phases.firstByte, timings.response! - timings.upload!);
	assert.strictEqual(timings.phases.download, undefined);
	assert.strictEqual(timings.phases.total, timings.error! - timings.start);
});

test('a response timeout exposes timings that stop after the upload', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	const error = await rejects<TimeoutError>(got('', {timeout: {response: 100}, retry: {limit: 0}}), errorMatching(TimeoutError, {event: 'response'}));
	const {timings} = error;

	assert.ok(timings.upload !== undefined);
	assert.strictEqual(timings.response, undefined);
	assert.strictEqual(timings.phases.firstByte, undefined);
	assert.strictEqual(timings.phases.total, timings.error! - timings.start);
});

test('a timeout before any request exists exposes minimal timings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const error = await rejects<TimeoutError>(got('', {timeout: {request: 0}, retry: {limit: 0}}), errorMatching(TimeoutError, {event: 'request'}));

	assert.deepStrictEqual(error.timings, {
		start: error.timings.start,
		error: error.timings.start,
		phases: {total: 0},
	});
});

test('a stream timeout error carries the timings of the stream', withServer, async (_t, server, got) => {
	server.get('/', () => {});

	const stream = got.stream('', {timeout: {response: 100}, retry: {limit: 0}});
	const error = await rejects<TimeoutError>(getStream(stream), errorMatching(TimeoutError, {event: 'response'}));

	assert.ok(stream.timings);
	assert.strictEqual(error.timings, stream.timings);
	assert.ok(error.timings.error !== undefined);
});

test('each retry attempt records its own timings', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.statusCode = ++requests === 1 ? 503 : 200;
		response.end();
	});

	const attemptTimings: Timings[] = [];
	const response = await got('', {
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			beforeRetry: [
				error => {
					attemptTimings.push(error.timings!);
				},
			],
		},
	});

	const [failedTimings] = attemptTimings;
	const {timings} = response;
	assert.strictEqual(attemptTimings.length, 1);
	assert.ok(timings);
	assert.ok(failedTimings?.end !== undefined);
	assert.notStrictEqual(timings, failedTimings);
	assert.strictEqual(timings.phases.total, timings.end! - timings.start);
});
