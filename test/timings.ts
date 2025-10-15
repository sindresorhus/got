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
	const {timings} = await got('https://www.google.com/', {http2: true});

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
