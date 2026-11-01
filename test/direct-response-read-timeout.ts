import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import http from 'node:http';
import {once} from 'node:events';
import {Socket} from 'node:net';
import {gzipSync} from 'node:zlib';
import getStream from 'get-stream';
import {TimeoutError, type OptionsInit, type RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const api of ['promise', 'stream']) {
	for (const source of ['factory', 'hook']) {
		for (const compressed of [false, true]) {
			test(`the read timeout bounds a direct ${source} response through ${api} with compression ${compressed}`, withServer, async (t, server, got) => {
				const payload = compressed ? gzipSync('partial') : Buffer.from('partial');
				const headers = {'content-length': '100', ...(compressed && {'content-encoding': 'gzip'})};
				server.get('/', (_request, response) => {
					response.writeHead(200, headers);
					response.write(payload);
				});
				let nativeResponse: http.IncomingMessage | undefined;
				let hookError: RequestError | undefined;
				let failures = 0;
				const options: OptionsInit = {
					retry: {limit: 0},
					timeout: {read: 20},
					signal: AbortSignal.timeout(500),
					hooks: {
						beforeError: [error => {
							assert.strictEqual(nativeResponse?.destroyed, true);
							failures++;
							hookError = error;
							return error;
						}],
					},
				};
				if (source === 'factory') {
					options.request = async (url, options) => {
						const request = http.get(url, options);
						const [response] = await once(request, 'response');
						nativeResponse = response as http.IncomingMessage;
						return nativeResponse;
					};
				} else {
					options.hooks!.beforeRequest = [() => {
						nativeResponse = new http.IncomingMessage(new Socket());
						nativeResponse.statusCode = 200;
						nativeResponse.headers = headers;
						nativeResponse.push(payload);
						return nativeResponse;
					}];
				}

				t.after(() => {
					nativeResponse?.destroy();
				});
				const operation = api === 'promise' ? got('', options) : getStream(got.stream('', options));
				const error = await operation.catch((error: unknown) => error);
				assert.ok(error instanceof TimeoutError);
				assert.strictEqual(error.event, 'read');
				assert.strictEqual(error.code, 'ETIMEDOUT');
				assert.strictEqual(error, hookError);
				assert.strictEqual(failures, 1);
				assert.strictEqual(nativeResponse?.destroyed, true);
			});
		}
	}
}

test('a direct-response read timeout retries with a fresh response', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		if (requests === 1) {
			response.writeHead(200, {'content-length': 100});
			response.write('partial');
		} else {
			response.end('complete');
		}
	});
	const responses: http.IncomingMessage[] = [];
	let retries = 0;
	const response = await got('', {
		timeout: {read: 20},
		signal: AbortSignal.timeout(1000),
		retry: {limit: 1, calculateDelay: () => 1},
		async request(url, options) {
			const request = http.get(url, options);
			const [response] = await once(request, 'response');
			responses.push(response as http.IncomingMessage);
			return response as http.IncomingMessage;
		},
		hooks: {
			beforeRetry: [error => {
				retries++;
				assert.ok(error instanceof TimeoutError);
				assert.strictEqual(error.event, 'read');
				assert.strictEqual(responses[0]?.destroyed, true);
			}],
		},
	});
	assert.strictEqual(response.body, 'complete');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(retries, 1);
	assert.strictEqual(requests, 2);
	assert.strictEqual(responses.length, 2);
});
