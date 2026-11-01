import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';
import {promisify} from 'node:util';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const source = await fs.readFile(new URL('../source/core/options.ts', import.meta.url), 'utf8');
const section = source.split('\tIt should return an object representing Got options pointing to the next page.', 2)[1];
assert.ok(section);
const example = /@example\n\t```\n(?<code>.*?)\n\t```/sv.exec(section)?.groups?.code;
assert.ok(example);

for (const size of [0, 3, 23]) {
	test(`the offset pagination example fetches and collects ${size} items`, withServer, async (t, server) => {
		const items = Array.from({length: size}, (_, index) => index);
		const requested: Array<{limit: number; offset: number}> = [];
		server.get('/items', (request, response) => {
			const limit = Number(request.query.limit);
			const offset = Number(request.query.offset);
			requested.push({limit, offset});
			response.json(items.slice(offset, offset + limit));
		});
		const script = example
			.replace('import got from \'got\';', () => `import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};`)
			.replace('\'https://example.com/items\'', () => JSON.stringify(`${server.url}/items`));
		const {stdout} = await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', `${script}\nconsole.log(JSON.stringify(items));`], {
			cwd: new URL('../', import.meta.url),
			timeout: 15_000,
			signal: t.signal,
		});
		assert.deepStrictEqual(JSON.parse(stdout.trim().split('\n').at(-1)!), items);
		assert.deepStrictEqual(requested, size < 10 ? [{limit: 10, offset: 0}] : [{limit: 10, offset: 0}, {limit: 10, offset: 10}, {limit: 10, offset: 20}]);
	});
}
