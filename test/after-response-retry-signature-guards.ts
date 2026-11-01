import assert from 'node:assert/strict';
import {RetryError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('the afterResponse retry callback returns its retry signal as a rejected Promise', withServer, async (_t, server, got) => {
	let requests = 0;
	let caught = false;
	server.get('/', (_request, response) => {
		requests++;
		response.end('original response');
	});
	const response = await got('', {
		hooks: {
			afterResponse: [async (response, retryWithMergedOptions) => {
				const retry = retryWithMergedOptions({context: {retryPayload: true}});
				assert.ok(retry instanceof Promise);
				assert.strictEqual(response.request.destroyed, false);
				await assert.rejects(retry, error => {
					assert.ok(error instanceof RetryError);
					assert.strictEqual(error.request, response.request);
					caught = true;
					return true;
				});

				return response;
			}],
		},
	});
	assert.strictEqual(caught, true);
	assert.strictEqual(response.body, 'original response');
	assert.strictEqual(response.request.options.context.retryPayload, true);
	assert.strictEqual(requests, 1);
});
