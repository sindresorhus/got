import assert from 'node:assert/strict';
import type {ClientRequest} from 'node:http';
import {once} from 'node:events';
import {AbortError, RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('clean stream destruction retains its established completion timing fallback', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('partial');
	});
	const request = got.stream('');
	const closed = once(request, 'close');
	request.once('data', () => {
		request.destroy();
	});
	request.resume();
	await closed;
	assert.ok(request.timings?.response !== undefined);
	assert.ok(request.timings.end !== undefined);
	assert.strictEqual(request.timings.phases.total, request.timings.end - request.timings.start);
});

for (const outcome of ['throw', 'abort']) {
	test(`actual response EOF keeps its completion timing when an afterResponse hook later reports ${outcome}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('complete');
		});
		const controller = new AbortController();
		const cause = new Error('The response hook failed');
		let nativeEnds = 0;
		const observe = (request: ClientRequest) => {
			request.once('response', response => {
				response.once('end', () => {
					nativeEnds++;
				});
			});
		};

		const operation = got('', {
			signal: controller.signal,
			retry: {limit: 0},
			hooks: {
				afterResponse: [response => {
					if (outcome === 'abort') {
						controller.abort(cause);
						return response;
					}

					throw cause;
				}],
			},
		}).on('request', observe);
		const error = await operation.catch((error: unknown) => error);
		assert.ok(error instanceof RequestError);
		assert.strictEqual(error.cause, cause);
		assert.strictEqual(error instanceof AbortError, outcome === 'abort');
		assert.strictEqual(nativeEnds, 1);
		assert.ok(error.timings?.end !== undefined);
		assert.strictEqual(error.timings.phases.total, error.timings.end - error.timings.start);
	});
}
