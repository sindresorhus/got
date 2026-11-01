import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import runExample from './helpers/run-example.js';

test('the plugin guide reads the profile date from the example client response', withServer, async (_t, server) => {
	let authorization: string | undefined;
	server.get('/users/sindresorhus', (request, response) => {
		authorization = request.headers.authorization;
		response.setHeader('x-ratelimit-limit', '60');
		response.setHeader('x-ratelimit-remaining', '59');
		response.setHeader('x-ratelimit-reset', '1261317452');
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Use the GitHub API's field name.
		response.json({created_at: '2009-12-20T13:37:32Z'});
	});
	const guide = await fs.readFile(new URL('../documentation/lets-make-a-plugin.md', import.meta.url), 'utf8');
	const section = guide.split('## Woah. Is that it?', 2)[1];
	assert.ok(section);
	const usage = /```js\n(?<code>.*?)\n```/sv.exec(section)?.groups?.code;
	assert.ok(usage);
	assert.strictEqual(usage.split('import ghGot from \'gh-got\';').length, 2);
	const stdout = await runExample('gh-got.js', [
		['\'https://api.github.com\'', JSON.stringify(server.url)],
		['token: process.env.GITHUB_TOKEN,', 'token: \'example-test-token\','],
		['export default instance;', usage.replace('import ghGot from \'gh-got\';', 'const ghGot = instance;')],
	]);
	assert.strictEqual(stdout.trim(), 'Sindre\'s GitHub profile was created on Sun, 20 Dec 2009 13:37:32 GMT');
	assert.strictEqual(authorization, 'token example-test-token');
});
