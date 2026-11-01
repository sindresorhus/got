import assert from 'node:assert/strict';
import type {ClientRequest} from 'node:http';
import {
	AbortError,
	TimeoutError,
	type Progress,
} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const api of ['promise', 'stream']) {
	for (const cancellation of ['controller', 'timeout']) {
		test(`a ${api} ${cancellation} signal does not report successful response completion during an aborted download`, withServer, async (_t, server, got) => {
			server.get('/', (_request, response) => {
				response.writeHead(200, {'content-length': '100'});
				response.write('partial');
			});
			const controller = new AbortController();
			const signal = cancellation === 'controller' ? controller.signal : AbortSignal.timeout(1000);
			const cause = new Error('Cancel the unfinished response');
			let nativeEnds = 0;
			let downloaded = false;
			const observeRequest = (request: ClientRequest) => {
				request.once('response', response => {
					response.once('end', () => {
						nativeEnds++;
					});
				});
			};

			const observeProgress = (progress: Progress) => {
				if (progress.transferred > 0) {
					downloaded = true;
					if (cancellation === 'controller') {
						controller.abort(cause);
					}
				}
			};

			const options = {signal, retry: {limit: 0}};
			const operation = api === 'promise'
				? got('', options).on('request', observeRequest).on('downloadProgress', observeProgress)
				: got.stream('', options).on('request', observeRequest).on('downloadProgress', observeProgress).toArray();
			const error = await operation.catch((error: unknown) => error);
			if (cancellation === 'controller') {
				assert.ok(error instanceof AbortError);
				assert.strictEqual(error.cause, cause);
			} else {
				assert.ok(error instanceof TimeoutError);
				assert.strictEqual(error.cause, signal.reason);
			}

			assert.strictEqual(downloaded, true);
			assert.strictEqual(nativeEnds, 0);
			assert.ok(error.timings?.response !== undefined);
			assert.strictEqual(error.timings.end, undefined);
			assert.strictEqual(error.timings.phases.download, undefined);
		});
	}
}
