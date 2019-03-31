import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';

test('promise mode', withServer, async (t, server) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	server.get('/404', (request, response) => {
		response.statusCode = 404;
		response.end('not found');
	});

	t.is((await got.get(server.url)).body, 'ok');

	const error = await t.throwsAsync(() => got.get(`${server.url}/404`));
	t.is(error.response.body, 'not found');

	const error2 = await t.throwsAsync(() => got.get('.com', {retry: 0}));
	t.truthy(error2);
});
