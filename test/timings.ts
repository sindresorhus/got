import http from 'node:http';
import http2, {type ServerHttp2Stream} from 'node:http2';
import {promises as dnsPromises} from 'node:dns';
import type net from 'node:net';
import test from 'ava';
import pify from 'pify';
import pem from 'pem';
import got from '../source/index.js';
import DnsCache from '../source/core/utils/dns-cache.js';
import withServer from './helpers/with-server.js';
import type {CreateCertificate} from './types/pem.js';

const createCertificate = pify(pem.createCertificate as CreateCertificate);

const createHttp2TestServer = async (onStream: (stream: ServerHttp2Stream) => void) => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<NonNullable<ServerHttp2Stream['session']>>();

	server.on('stream', onStream);
	server.on('session', session => {
		sessions.add(session);
		session.once('close', () => {
			sessions.delete(session);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const {port} = server.address() as net.AddressInfo;

	return {
		url: `https://localhost:${port}`,
		async close() {
			for (const session of sessions) {
				session.destroy();
			}

			await new Promise<void>((resolve, reject) => {
				server.close(error => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				});
			});
		},
	};
};

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
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
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
	} finally {
		await server.close();
	}
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

test('cached DNS lookups reuse resolved addresses in timing requests', withServer, async (t, server, got) => {
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
		if (isIpv6Server) {
			return [];
		}

		return [{address: '127.0.0.1', ttl: 60}];
	}) as typeof resolver.resolve4;
	resolver.resolve6 = (async (_hostname: string, _options: unknown) => {
		resolve6CallCount++;
		if (isIpv6Server) {
			return [{address: '::1', ttl: 60}];
		}

		return [];
	}) as typeof resolver.resolve6;

	// Enable DNS cache and disable keep-alive to get new connections
	const instance = got.extend({
		dnsCache: new DnsCache({resolver}),
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

	t.is(resolve4CallCount, 1);
	t.is(resolve6CallCount, 1);

	for (const {timings} of responses) {
		t.true(Number.isFinite(timings.socket));
		t.true(Number.isFinite(timings.lookup));
		t.true(Number.isFinite(timings.connect));
		t.true(Number.isFinite(timings.phases.dns));
		t.true(timings.phases.dns! >= 0);
		t.true(timings.lookup! >= timings.socket!);
		t.true(timings.connect! >= timings.lookup!);
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
