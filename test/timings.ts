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

test.failing('http/2 timings', async t => {
	const {timings} = await got('https://httpbin.org/anything', {http2: true});

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
