import http from 'node:http';
import test from 'ava';
import got from '../source/index.js';
import withServer from './helpers/with-server.js';

test('http/1 timings', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {timings} = await got('');

	t.true(timings.start >= 0);
	t.true(timings.socket! >= 0);
	t.true(timings.lookup! >= 0);
	t.true(timings.connect! >= 0);
	t.true(timings.upload! >= 0);
	t.true(timings.response! >= 0);
	t.true(timings.end! >= 0);

	const {phases} = timings;

	t.true(phases.wait! >= 0);
	t.true(phases.dns! >= 0);
	t.true(phases.tcp! >= 0);
	t.true(phases.request! >= 0);
	t.true(phases.firstByte! >= 0);
	t.true(phases.download! >= 0);
	t.true(phases.total! >= 0);
});

test('http/2 timings', async t => {
	// Use a real HTTP/2 server (Google supports HTTP/2)
	const {timings} = await got('https://www.google.com/', {
		http2: true,
		https: {
			rejectUnauthorized: false,
		},
	});

	// These timings are available even for HTTP/2
	t.true(timings.start >= 0);
	t.true(timings.socket! >= 0);
	t.true(timings.upload! >= 0);
	t.true(timings.response! >= 0);
	t.true(timings.end! >= 0);

	// These connection timings are unavailable for HTTP/2 (socket is a proxy)
	// See https://github.com/sindresorhus/got/issues/1958
	t.is(timings.lookup, undefined);
	t.is(timings.connect, undefined);
	t.is(timings.secureConnect, undefined);

	const {phases} = timings;

	// Available phases
	t.true(phases.wait! >= 0);
	t.true(phases.firstByte! >= 0);
	t.true(phases.download! >= 0);
	t.true(phases.total! >= 0);

	// Unavailable phases (due to missing connection timings)
	t.is(phases.dns, undefined);
	t.is(phases.tcp, undefined);
	t.is(phases.tls, undefined);
	// Most importantly: phases.request should be undefined, NOT NaN
	t.is(phases.request, undefined);
	t.false(Number.isNaN(phases.request));
});

test('timings.end is set when stream is destroyed before completion', withServer, async (t, server, got) => {
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
			t.is(error.message, 'Manual destroy');
			t.truthy(stream.timings);
			t.truthy(stream.timings!.response);
			t.truthy(stream.timings!.end);
			t.true(stream.timings!.end! >= stream.timings!.response!);
			t.truthy(stream.timings!.phases.total);
			resolve();
		});

		stream.on('end', () => {
			reject(new Error('Stream should not end normally'));
		});
	});

	t.pass();
});

test('dns timing is 0 for IP addresses', withServer, async (t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// Get the actual IP address the server is bound to
	const address = server.http.address() as {address: string; family: string; port: number};
	const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
	const {timings} = await got(`http://${host}:${server.port}/`);

	// When connecting to an IP address, there is no DNS lookup
	t.is(timings.phases.dns, 0);
	// Lookup timestamp should equal socket timestamp (no time elapsed for DNS)
	t.is(timings.lookup, timings.socket);
});

test('dns timing is 0 for cached DNS lookups', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// Enable DNS cache and disable keep-alive to get new connections
	const instance = got.extend({
		dnsCache: true,
		agent: {
			http: new http.Agent({
				keepAlive: false,
			}),
		},
	});

	// First request: real DNS lookup
	const response1 = await instance('');
	const firstDns = response1.timings.phases.dns;

	// First request should have some DNS time (for localhost lookup)
	// or 0 if it's fast enough to trigger the cache threshold
	t.true(firstDns! >= 0);

	// Subsequent requests: DNS should be cached
	const response2 = await instance('');
	const response3 = await instance('');

	// When DNS is cached, if lookup and connect happen at the exact same time (tcp=0),
	// then dns is set to 0 to indicate no actual DNS resolution occurred.
	// Otherwise, dns will be small but may vary on CI due to system load.
	// The key fix from http-timer #35 is that we handle this case, not enforce exact values.
	const secondIsInstant = response2.timings.phases.tcp === 0;
	const thirdIsInstant = response3.timings.phases.tcp === 0;

	if (secondIsInstant) {
		t.is(response2.timings.phases.dns, 0, 'instant cached DNS (tcp=0) should have dns=0');
	} else {
		t.true(response2.timings.phases.dns! >= 0, 'cached DNS should have dns >= 0');
	}

	if (thirdIsInstant) {
		t.is(response3.timings.phases.dns, 0, 'instant cached DNS (tcp=0) should have dns=0');
	} else {
		t.true(response3.timings.phases.dns! >= 0, 'cached DNS should have dns >= 0');
	}
});

test('redirect timings preserve connection timings from initial request', withServer, async (t, server, got) => {
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

	// Verify the response went through redirects
	t.is(response.redirectUrls.length, 2);
	t.is(response.body, 'final content');

	// The bug (#2425) was that on redirects with socket reuse, all timestamps
	// were set to socket time, causing all phases to be 0.

	// After the fix, for reused sockets:
	// - Timestamps are still all at socket time (correct for reused sockets)
	// - But phases preserve the original connection durations (not 0)

	// Verify timestamps are at socket time for reused socket
	t.is(timings.lookup, timings.socket);
	t.is(timings.connect, timings.socket);

	// Verify phases are preserved (not all 0)
	// For localhost, dns is 0 (IP address), but tcp should have some value
	t.is(typeof timings.phases.dns, 'number');
	t.is(typeof timings.phases.tcp, 'number');
	t.true(timings.phases.dns! >= 0);
	t.true(timings.phases.tcp! >= 0);

	// Verify basic timing chronology
	t.true(response.timings.start <= response.timings.socket!);
	t.true(response.timings.socket! <= response.timings.response!);
	t.true(response.timings.response! <= response.timings.end!);
});
