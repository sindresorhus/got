import assert from 'node:assert/strict';
import getStream from 'get-stream';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import got, {AbortError} from 'got';

test('the built package supports instances, JSON uploads, shortcuts and events', withServer, async (_t, server) => {
	server.post('/echo', async (request, response) => {
		response.json({payload: JSON.parse(await getStream(request)), header: request.headers['x-package-test']});
	});
	const client = got.extend({prefixUrl: server.url});
	let completedDownloads = 0;
	const result = await client.post('echo', {
		json: {message: 'built package'},
		headers: {'x-package-test': 'retained'},
	}).json<{payload: {message: string}; header: string}>().on('downloadProgress', progress => {
		if (progress.percent === 1) {
			completedDownloads++;
		}
	});
	assert.deepStrictEqual(result, {payload: {message: 'built package'}, header: 'retained'});
	assert.strictEqual(completedDownloads, 1);
});

test('the built package preserves abort error exports and causes', withServer, async (_t, server) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end('unexpected request');
	});
	const reason = new Error('Canceled before dispatch');
	await assert.rejects(got(server.url, {signal: AbortSignal.abort(reason)}), (error: unknown) => {
		assert.ok(error instanceof AbortError);
		assert.strictEqual(error.code, 'ERR_ABORTED');
		assert.strictEqual(error.cause, reason);
		return true;
	});
	assert.strictEqual(requests, 0);
});
