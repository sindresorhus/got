import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {IncomingMessage} from 'node:http';
import {PassThrough} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import got, {ReadError} from '../source/index.js';
import test from './helpers/test.js';

for (const contentEncoding of ['gzip', 'gzip, gzip']) {
	for (const useHook of [true, false]) {
		test(`a ${useHook ? 'beforeRequest' : 'custom request'} ${contentEncoding} source error rejects with its original cause`, async t => {
			const source = Object.assign(new PassThrough(), {
				statusCode: 200,
				headers: {'content-encoding': contentEncoding},
				url: 'http://example.invalid/',
			});
			const cause = new Error('Response source failed');
			const sourceFailure = once(source, 'error');
			const controller = new AbortController();
			const request = got(source.url, {
				signal: controller.signal,
				retry: {limit: 0},
				...(useHook ? {hooks: {beforeRequest: [() => source as unknown as IncomingMessage]}} : {request: () => source as unknown as IncomingMessage}),
			});
			t.after(() => {
				controller.abort();
				source.destroy();
			});
			const outcome = request.catch((error: unknown) => error);
			// Let Got adopt the response before the source fails. The caller observes the source error too.
			await setImmediate();
			const body = gzipSync('partial body');
			source.write(contentEncoding === 'gzip' ? body : gzipSync(body));
			source.destroy(cause);
			await sourceFailure;
			await setImmediate();
			// A lost source error leaves the request pending. Cancellation makes that failure deterministic.
			controller.abort();
			const error = await outcome;
			assert.ok(error instanceof ReadError);
			assert.strictEqual(error.cause, cause);
			assert.strictEqual(source.destroyed, true);
		});
	}
}
