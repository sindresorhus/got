import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import getStream from 'get-stream';
import ResponseLike from 'responselike';
import type {OptionsInit, Request} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const api of ['promise', 'stream']) {
	for (const source of ['hook', 'factory']) {
		for (const kind of ['sync iterator', 'async iterator', 'Node Readable', 'Web ReadableStream']) {
			test(`a direct ${source} response skips and releases a ${kind} upload through ${api}`, withServer, async (t, server, got) => {
				let requests = 0;
				let opened = 0;
				let reads = 0;
				let released = 0;
				let pipes = 0;
				const progress: number[] = [];
				server.post('/', (_request, response) => {
					requests++;
					response.end('unexpected request');
				});
				let body: OptionsInit['body'];
				if (kind === 'Node Readable') {
					body = new Readable({
						read() {
							reads++;
							this.destroy(new Error('The unused upload must not be read'));
						},
						destroy(error, callback) {
							released++;
							callback(error);
						},
					});
				} else if (kind === 'Web ReadableStream') {
					body = new ReadableStream({
						pull() {
							reads++;
							throw new Error('The unused upload must not be read');
						},
						cancel() {
							released++;
						},
					}, {highWaterMark: 0});
				} else {
					const iterator = {
						next() {
							reads++;
							throw new Error('The unused upload must not be read');
						},
						return() {
							released++;
							return {done: true as const, value: undefined};
						},
					};
					if (kind === 'sync iterator') {
						body = Object.assign(iterator, {
							[Symbol.iterator]() {
								opened++;
								return iterator;
							},
						});
					} else {
						const asyncIterator = {
							next() {
								reads++;
								return Promise.reject(new Error('The unused upload must not be read'));
							},
							return() {
								released++;
								return Promise.resolve({done: true as const, value: undefined});
							},
							[Symbol.asyncIterator](): AsyncIterator<unknown> {
								opened++;
								return asyncIterator;
							},
						};
						body = asyncIterator;
					}
				}

				const response = new ResponseLike({
					statusCode: 200, headers: {}, body: Buffer.from('cached response'), url: server.url,
				});
				const options = {
					body,
					retry: {limit: 0},
					...(source === 'factory' ? {request: () => response} : {hooks: {beforeRequest: [() => response]}}),
				} satisfies OptionsInit;
				let request: Request | undefined;
				t.after(() => {
					request?.destroy();
				});
				let result: string;
				if (api === 'promise') {
					const response = await got.post('', options).on('uploadProgress', event => {
						progress.push(event.transferred);
					});
					request = response.request;
					result = response.body;
				} else {
					request = got.stream.post('', options).on('uploadProgress', event => {
						progress.push(event.transferred);
					});
					request.on('pipe', () => {
						pipes++;
					});
					const finished = once(request, 'finish');
					[result] = await Promise.all([getStream(request), finished]);
				}

				assert.ok(request);
				assert.strictEqual(result, 'cached response');
				assert.strictEqual(request.isReadonly, true);
				assert.strictEqual(request.writableFinished, true);
				assert.strictEqual(opened, 0);
				assert.strictEqual(reads, 0);
				assert.strictEqual(requests, 0);
				assert.deepStrictEqual(progress, []);
				assert.strictEqual(pipes, api === 'stream' && kind === 'Node Readable' ? 1 : 0);
				request.destroy();
				await setImmediate();
				assert.strictEqual(released, 1);
				if (body instanceof ReadableStream) {
					assert.strictEqual(body.locked, false);
				}
			});
		}
	}
}
