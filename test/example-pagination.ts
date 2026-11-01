import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import runExample from './helpers/run-example.js';

test('the pagination example stops at the first old commit without fetching another page', withServer, async (_t, server) => {
	const now = Date.now();
	const recent = {commit: {message: 'recent', committer: {date: new Date(now).toISOString()}}};
	const old = {commit: {message: 'old', committer: {date: new Date(now - (8 * 86_400_000)).toISOString()}}};
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.json(requests === 1 ? [recent, old] : [old]);
	});
	const stdout = await runExample('pagination.js', [['\'https://api.github.com/repos/sindresorhus/got/commits\'', JSON.stringify(server.url)]]);
	assert.deepStrictEqual(stdout.trim().split('\n').slice(1), ['recent']);
	assert.strictEqual(requests, 1);
});
