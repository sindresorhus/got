import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';
import {promisify} from 'node:util';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('the pagination guide example stops at the first old commit', withServer, async (_t, server) => {
	const now = Date.now();
	const recent = {commit: {message: 'recent', committer: {date: new Date(now).toISOString()}}};
	const old = {commit: {message: 'old', committer: {date: new Date(now - (8 * 86_400_000)).toISOString()}}};
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.json(requests === 1 ? [recent, old] : [old]);
	});
	// Run the guide's actual code block so a separate runnable copy cannot hide stale instructions.
	const guide = await fs.readFile(new URL('../documentation/4-pagination.md', import.meta.url), 'utf8');
	const example = /### Example\n.*?```js\n(?<code>.*?)\n```/sv.exec(guide)?.groups?.code;
	assert.ok(example);
	const script = example
		.replace('import got from \'got\';', () => `import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};`)
		.replace('\'https://api.github.com/repos/sindresorhus/got/commits\'', () => JSON.stringify(server.url));
	const {stdout} = await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script], {
		cwd: new URL('../', import.meta.url),
		timeout: 15_000,
	});
	assert.deepStrictEqual(stdout.trim().split('\n').slice(1), ['recent']);
	assert.strictEqual(requests, 1);
});
