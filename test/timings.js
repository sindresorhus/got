import test from 'ava';
import got from '../dist';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.end('ok');
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

// #687
test('sensible timings', async t => {
	const {timings} = await got(s.url);
	t.true(timings.phases.request < 1000);
});
