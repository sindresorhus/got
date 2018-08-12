import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.end('ok');
	});

	s.on('/404', (request, response) => {
		response.statusCode = 404;
		response.end('not found');
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('promise mode', async t => {
	t.is((await got.get(s.url)).body, 'ok');

	const error = await t.throwsAsync(got.get(`${s.url}/404`));
	t.is(error.response.body, 'not found');

	const error2 = await t.throwsAsync(got.get('.com', {retry: 0}));
	t.truthy(error2);
});
