import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {setImmediate} from 'node:timers/promises';
import {RequestError, type Progress} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const api of ['promise', 'stream']) {
	for (const direction of ['upload', 'download']) {
		test(`an initial ${direction} progress observer failure preserves asynchronous error hooks in the ${api} API`, withServer, async (_t, server, got) => {
			server.all('/', (request, response) => {
				request.on('error', () => {});
				request.resume();
				response.end('response');
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const cause = new Error('Initial progress observer failed');
			let hooks = 0;
			let settled = false;
			const options = {
				...(direction === 'upload' && {method: 'POST', body: Buffer.alloc(10)}),
				retry: {limit: 0},
				hooks: {
					beforeError: [async (error: RequestError) => {
						hooks++;
						assert.strictEqual(error.cause, cause);
						entered.resolve();
						await release.promise;
						return error;
					}],
				},
			};
			const onProgress = (progress: Progress) => {
				if (progress.transferred === 0) {
					throw cause;
				}
			};

			const eventName = direction === 'upload' ? 'uploadProgress' : 'downloadProgress';
			const request = api === 'promise'
				? got('', options).on(eventName, onProgress)
				: got.stream('', options).on(eventName, onProgress);
			const operation = api === 'promise' ? Promise.resolve(request) : (request as ReturnType<typeof got.stream>).toArray();
			const rejected = assert.rejects(operation.finally(() => {
				settled = true;
			}), error => error instanceof RequestError && error.cause === cause);
			try {
				await entered.promise;
				await setImmediate();
				assert.strictEqual(settled, false);
				assert.strictEqual(hooks, 1);
			} finally {
				release.resolve();
			}

			await rejected;
			assert.strictEqual(hooks, 1);
		});
	}
}
