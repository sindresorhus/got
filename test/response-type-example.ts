import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';
import {promisify} from 'node:util';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const source = await fs.readFile(new URL('../source/core/options.ts', import.meta.url), 'utf8');
const section = source.split('\tThe parsing method.\n', 2)[1];
assert.ok(section);
const example = /@example\n\t```\n(?<code>.*?)\n\t```/sv.exec(section)?.groups?.code;
assert.ok(example);

for (const payload of [{answer: 42}, ['unicorn', '🦄']]) {
	test(`the responseType example awaits its concurrent body shortcuts for ${JSON.stringify(payload)}`, withServer, async (t, server) => {
		const body = JSON.stringify(payload);
		let requests = 0;
		server.get('/', (_request, response) => {
			requests++;
			response.end(body);
		});
		const script = `
import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
const url = ${JSON.stringify(server.url)};
${example}
console.log(JSON.stringify({body: response.body, bytes: [...buffer], json}));
`;
		const {stdout} = await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script], {
			cwd: new URL('../', import.meta.url),
			timeout: 15_000,
			signal: t.signal,
		});
		assert.deepStrictEqual(JSON.parse(stdout), {body, bytes: [...new TextEncoder().encode(body)], json: payload});
		assert.strictEqual(requests, 1);
	});
}
