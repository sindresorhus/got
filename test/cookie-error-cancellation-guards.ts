import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {AbortError, type RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const streaming of [false, true]) {
	for (const scenario of ['open body', 'redirect', 'compressed body'] as const) {
		test(`cancellation interrupts cookie error body capture for an unfinished ${scenario} in the ${streaming ? 'stream' : 'promise'} API`, withServer, async (t, server, got) => {
			let requests = 0;
			const closed = Promise.withResolvers<void>();
			server.get('/', (_request, response) => {
				requests++;
				response.once('close', () => {
					closed.resolve();
				});
				response.setHeader('set-cookie', 'session=value');
				if (scenario === 'redirect') {
					response.status(302).setHeader('location', '/destination');
				}

				if (scenario === 'compressed body') {
					response.setHeader('content-encoding', 'gzip');
					response.write(gzipSync('unfinished response'));
				} else {
					response.write('unfinished response');
				}
			});
			server.get('/destination', (_request, response) => {
				requests++;
				response.end('must not follow');
			});
			const cause = new Error('Cookie storage failed');
			const entered = Promise.withResolvers<void>();
			const controller = new AbortController();
			t.after(() => {
				controller.abort();
			});
			const errors: Error[] = [];
			const options = {
				signal: controller.signal,
				retry: {limit: 0},
				cookieJar: {
					async getCookieString() {
						return '';
					},
					async setCookie() {
						entered.resolve();
						throw cause;
					},
				},
				hooks: {
					beforeError: [(error: RequestError) => {
						errors.push(error);
						return error;
					}],
				},
			};
			const operation = streaming ? got.stream('', options).toArray() : got('', options);
			const outcome = operation.catch((error: unknown) => error);
			await entered.promise;
			await setImmediate();
			// Cookie error reporting captures the complete response body. Cancellation must still interrupt a body that never ends.
			controller.abort();
			const error = await outcome;
			assert.ok(error instanceof AbortError);
			assert.strictEqual(error.cause, controller.signal.reason);
			assert.deepStrictEqual(errors, []);
			await closed.promise;
			assert.strictEqual(requests, 1);
		});
	}
}
