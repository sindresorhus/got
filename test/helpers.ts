import test from 'ava';
import got, {HTTPError} from '../source/index.js';
import withServer from './helpers/with-server.js';
import invalidUrl from './helpers/invalid-url.js';

test('works', withServer, async (t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/404', (_request, response) => {
		response.statusCode = 404;
		response.end('not found');
	});

	t.is((await got.get(server.url)).body, 'ok');

	const error = await t.throwsAsync<HTTPError>(got.get(`${server.url}/404`), {instanceOf: HTTPError});
	t.is(error.response.body, 'not found');

	const secondError = await t.throwsAsync(got.get('.com', {retry: {limit: 0}}));
	invalidUrl(t, secondError, '.com');
});
