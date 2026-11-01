import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {Readable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {AbortError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const update of ['plain', 'same-owner'] as const) {
	test(`an active afterResponse retry accepts a fresh body through ${update} options`, withServer, async (_t, server, got) => {
		const body = Readable.from(['replacement body']);
		let requests = 0;
		let initCalls = 0;
		server.all('/', async (request, response) => {
			requests++;
			const chunks = await request.toArray();
			response.end(requests === 1 ? 'first response' : Buffer.concat(chunks).toString());
		});
		try {
			const response = await got('', {
				retry: {limit: 0},
				hooks: {
					init: [plain => {
						if (plain.context?.retryPayload === true) {
							initCalls++;
						}
					}],
					afterResponse: [(response, retryWithMergedOptions) => {
						if (update === 'same-owner') {
							const {options} = response.request;
							options.method = 'POST';
							options.body = body;
							options.context = {retryPayload: true};
							return retryWithMergedOptions(options);
						}

						return retryWithMergedOptions({method: 'POST', body, context: {retryPayload: true}});
					}],
				},
			});
			assert.strictEqual(response.body, 'replacement body');
			assert.strictEqual(response.request.options.body, body);
			assert.strictEqual(requests, 2);
			assert.strictEqual(initCalls, update === 'plain' ? 1 : 0);
			assert.strictEqual(body.readableDidRead, true);
			assert.strictEqual(body.destroyed, true);
		} finally {
			body.destroy();
		}
	});
}

test('cancellation releases a body already accepted by an active afterResponse retry', withServer, async (_t, server, got) => {
	const body = new Readable({read() {}});
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const reason = new Error('Stop the accepted retry');
	let requests = 0;
	let retries = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end('first response');
	});
	const pending = got('', {
		signal: controller.signal,
		retry: {limit: 0},
		hooks: {
			afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({method: 'POST', body})],
			beforeRetry: [async error => {
				retries++;
				assert.strictEqual(error.options.body, body);
				entered.resolve();
				await release.promise;
			}],
		},
	}).catch((error: unknown) => error);
	try {
		await Promise.race([entered.promise, pending.then(() => assert.fail('The accepted retry must enter its hook'))]);
		assert.strictEqual(body.destroyed, false);
		controller.abort(reason);
		const error = await pending;
		assert.ok(error instanceof AbortError);
		assert.strictEqual(error.cause, reason);
		assert.strictEqual(body.destroyed, true);
		assert.strictEqual(body.readableDidRead, false);
	} finally {
		release.resolve();
		body.destroy();
		await pending;
	}

	await setImmediate();
	assert.strictEqual(requests, 1);
	assert.strictEqual(retries, 1);
});
