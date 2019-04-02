import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';

test('works', withServer, async (t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/404', (_request, response) => {
		response.statusCode = 404;
		response.end('not found');
	});

	t.is((await got.get(server.url)).body, 'ok');

	const error = await t.throwsAsync(got.get(`${server.url}/404`), got.HTTPError);
	t.is(error.response.body, 'not found');

	await t.throwsAsync(got.get('.com', {retry: 0}), 'Invalid URL: .com');
});
