import assert from 'node:assert/strict';
import got, {HTTPError} from '../source/index.js';
import test from './helpers/test.js';
import {rejects} from './helpers/rejects.js';
import withServer from './helpers/with-server.js';
import invalidUrl from './helpers/invalid-url.js';

test('works', withServer, async (_t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/404', (_request, response) => {
		response.statusCode = 404;
		response.end('not found');
	});

	const {body} = await got.get(server.url);
	assert.strictEqual(body, 'ok');

	const error = await rejects(got.get(`${server.url}/404`), HTTPError);
	assert.strictEqual(error?.response.body, 'not found');

	const secondError = await rejects(got.get('.com', {retry: {limit: 0}}));
	invalidUrl(secondError, '.com');
});
