import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

/**
Run the actual example script with local test configuration and return its output.
*/
export default async function runExample(filename: string, replacements: ReadonlyArray<readonly [string, string]>): Promise<string> {
	let script = await fs.readFile(new URL(`../../documentation/examples/${filename}`, import.meta.url), 'utf8');
	for (const [from, to] of [
		['\'../../dist/source/index.js\'', JSON.stringify(new URL('../../source/index.ts', import.meta.url).href)] as const,
		...replacements,
	]) {
		assert.strictEqual(script.split(from).length, 2, `The example must contain exactly one ${from}`);
		script = script.replace(from, () => to);
	}

	const {stdout} = await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script], {
		cwd: fileURLToPath(new URL('../../', import.meta.url)),
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Keep the example's environment input independent of the developer's secret.
		env: {...process.env, SECRET: 'example-test-secret'},
		timeout: 15_000,
	});
	return stdout;
}
