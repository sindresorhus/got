import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import process from 'node:process';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import test from './helpers/test.js';

test('the supplied HTTPS server serves the default benchmark URL', {timeout: 30_000}, async t => {
	if (!process.allowedNodeEnvironmentFlags.has('--experimental-bench')) {
		t.skip('The benchmark runner requires Node.js with --experimental-bench support.');
		return;
	}

	// The benchmark files use fixed ports. Do not connect to another process's server.
	for (const port of [8080, 8081]) {
		const reservation = net.createServer();
		try {
			// eslint-disable-next-line no-await-in-loop
			await new Promise<void>((resolve, reject) => {
				reservation.once('error', reject);
				reservation.listen(port, resolve);
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
				t.skip(`The benchmark integration test requires port ${port} to be available.`);
				return;
			}

			throw error;
		} finally {
			if (reservation.listening) {
				// Release this port before checking the next one.
				// eslint-disable-next-line no-await-in-loop
				await new Promise<void>(resolve => {
					reservation.close(() => {
						resolve();
					});
				});
			}
		}
	}

	const options = {
		cwd: new URL('..', import.meta.url),
		maxBuffer: 64 * 1024,
		timeout: 20_000,
		signal: t.signal,
	};
	const server = promisify(execFile)(process.execPath, ['--import=tsx/esm', 'benchmark/server.ts'], options);
	// A killed server rejects this promise. Observe it while waiting for its readiness line.
	void server.catch(() => {});
	const output = createInterface({input: server.child.stdout!});

	try {
		const [line] = await Promise.race([
			once(output, 'line', {signal: AbortSignal.timeout(15_000)}),
			server.then(() => {
				throw new Error('The benchmark server exited before it was ready.');
			}),
		]);
		assert.match(line as string, /^Listening at https:\/\/localhost:\d+$/v);

		const {stdout} = await promisify(execFile)(process.execPath, [
			'--import=tsx/esm',
			'--experimental-bench',
			'--bench',
			'--bench-name-pattern=^got - promise$',
			'--bench-warmup=0',
			'--bench-samples=1',
			'benchmark/index.ts',
		], options);
		assert.match(stdout, /1 completed, 0 failed/v);
	} finally {
		output.close();
		server.child.kill();
		await server.catch(() => {});
	}
});
