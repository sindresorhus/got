import test from 'ava';
import withServer, {withHttpsServer} from './helpers/with-server.js';

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

test('http/2 timings', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.json({data: 'test'});
	});

	const {timings} = await got({http2: true});

	t.true(timings.start >= 0);
	t.true(timings.socket! >= 0);
	t.true(timings.lookup! >= 0);
	t.true(timings.connect! >= 0);
	t.true(timings.secureConnect! >= 0);
	t.true(timings.upload! >= 0);
	t.true(timings.response! >= 0);
	t.true(timings.end! >= 0);

	const {phases} = timings;

	t.true(phases.wait! >= 0);
	t.true(phases.dns! >= 0);
	t.true(phases.tcp! >= 0);
	t.true(phases.tls! >= 0);
	t.true(phases.request! >= 0);
	t.true(phases.firstByte! >= 0);
	t.true(phases.download! >= 0);
	t.true(phases.total! >= 0);
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
