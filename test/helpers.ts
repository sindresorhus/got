import {IncomingMessage, ServerResponse} from 'http';
import test, {ExecutionContext} from 'ava';
import got from '../source';
import {HTTPError} from '../source/errors';
import withServer from './helpers/with-server';

test('works', withServer, async (t: ExecutionContext, server: any) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.end('ok');
	});

	server.get('/404', (_request: IncomingMessage, response: ServerResponse) => {
		response.statusCode = 404;
		response.end('not found');
	});

	t.is((await got.get(server.url)).body, 'ok');

	const error: HTTPError = await t.throwsAsync(got.get(`${server.url}/404`), got.HTTPError);
	t.is(error.response.body, 'not found');

	await t.throwsAsync(got.get('.com', {retry: 0}), 'Invalid URL: .com');
});
