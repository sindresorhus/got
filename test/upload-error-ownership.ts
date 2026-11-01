import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import http, {type ClientRequest} from 'node:http';
import {setImmediate} from 'node:timers/promises';
import getStream from 'get-stream';
import got, {
	HTTPError,
	RequestError,
	type RequestFunction,
	type Progress,
} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

const bodySize = 1024 * 1024;

for (const api of ['promise', 'stream']) {
	for (const [bodyType, body, transferEncoding] of [
		['Buffer', Buffer.alloc(bodySize), undefined],
		['string', 'a'.repeat(bodySize), undefined],
		['Uint8Array', new Uint8Array(bodySize), undefined],
		['single-chunk Buffer with unknown total', Buffer.alloc(1024), 'chunked'],
	] as const) {
		test(`a ${api} ${bodyType} upload stops when a progress error owns the request`, withServer, async (t, server, got) => {
			const firstChunkReceived = Promise.withResolvers<void>();
			let receivedBytes = 0;
			server.post('/', (request, response) => {
				request.on('error', () => {});
				request.on('data', (chunk: Uint8Array) => {
					receivedBytes += chunk.byteLength;
					firstChunkReceived.resolve();
				});
				request.once('end', () => {
					response.end('uploaded');
				});
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const cause = new Error('Upload progress observer failed');
			let nativeRequest: ClientRequest | undefined;
			let writeCount = () => 0;
			let errors = 0;
			let settled = false;
			let nativeCallbacks = 0;
			let nativeFinishes = 0;
			let bytesAtFailure = 0;
			const createRequest: RequestFunction = (url, options, callback) => {
				const request = http.request(url, options, callback);
				const originalWrite = request.write.bind(request);
				const write = t.mock.method(request, 'write', (chunk: Uint8Array, encoding: BufferEncoding | undefined, callback: (error?: Error) => void) => originalWrite(chunk, encoding ?? 'utf8', error => {
					nativeCallbacks++;
					callback(error ?? undefined);
				}));
				request.once('finish', () => {
					nativeFinishes++;
				});
				writeCount = () => write.mock.calls.length;
				nativeRequest = request;
				return request;
			};

			const options = {
				body,
				headers: {'transfer-encoding': transferEncoding},
				request: createRequest,
				retry: {limit: 0},
				hooks: {
					beforeError: [async (error: RequestError) => {
						errors++;
						assert.strictEqual(error.cause, cause);
						entered.resolve();
						await release.promise;
						return error;
					}],
				},
			};
			const observe = (progress: Progress) => {
				if (progress.transferred > 0) {
					assert.strictEqual(progress.total, transferEncoding === undefined ? bodySize : undefined);
					assert.strictEqual(bytesAtFailure, 0);
					bytesAtFailure = progress.transferred;
					throw cause;
				}
			};

			const operation = api === 'promise'
				? got.post('', options).on('uploadProgress', observe)
				: got.stream.post('', options).on('uploadProgress', observe).toArray();
			const result = operation.catch((error: unknown) => {
				settled = true;
				return error;
			});
			try {
				await Promise.race([entered.promise, result.then(() => assert.fail('The upload must wait for its error hook'))]);
				await firstChunkReceived.promise;
				// Each body chunk yields to the event loop. A claimed failure must prevent the next native write while error hooks are pending.
				await setImmediate();
				await setImmediate();
				assert.strictEqual(writeCount(), 1);
				assert.ok(receivedBytes > 0);
				assert.ok(receivedBytes <= bytesAtFailure);
				assert.strictEqual(nativeCallbacks, 1);
				assert.strictEqual(nativeFinishes, 0);
				assert.strictEqual(nativeRequest?.writableEnded, false);
				assert.strictEqual(nativeRequest?.destroyed, false);
				assert.strictEqual(settled, false);
			} finally {
				release.resolve();
				await result;
			}

			const error = await result;
			assert.ok(error instanceof RequestError);
			assert.strictEqual(error.cause, cause);
			assert.strictEqual(errors, 1);
			assert.strictEqual(nativeRequest?.destroyed, true);
			assert.strictEqual(nativeFinishes, 0);
		});
	}
}

for (const api of ['promise', 'stream']) {
	test(`a ${api} early HTTP error retains its body and stops the configured upload while error hooks wait`, withServer, async (t, server, got) => {
		let receivedBytes = 0;
		server.post('/', (request, response) => {
			request.on('error', () => {});
			request.on('data', (chunk: Uint8Array) => {
				receivedBytes += chunk.byteLength;
				if (!response.headersSent) {
					response.writeHead(413).end('upload rejected');
				}
			});
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let nativeRequest: ClientRequest | undefined;
		let writeCount = () => 0;
		let hookError: RequestError | undefined;
		const createRequest: RequestFunction = (url, options, callback) => {
			const request = http.request(url, options, callback);
			const write = t.mock.method(request, 'write');
			writeCount = () => write.mock.calls.length;
			nativeRequest = request;
			return request;
		};

		const options = {
			body: Buffer.alloc(bodySize),
			request: createRequest,
			retry: {limit: 0},
			hooks: {
				beforeError: [async (error: RequestError) => {
					assert.ok(error instanceof HTTPError);
					assert.strictEqual(error.response.body, 'upload rejected');
					hookError = error;
					entered.resolve();
					await release.promise;
					return error;
				}],
			},
		};
		const operation = api === 'promise' ? got.post('', options) : got.stream.post('', options).toArray();
		const result = operation.catch((error: unknown) => error);
		try {
			await Promise.race([entered.promise, result.then(() => assert.fail('The upload must wait for its error hook'))]);
			const writesAtFailure = writeCount();
			assert.ok(writesAtFailure > 0);
			await setImmediate();
			await setImmediate();
			assert.strictEqual(writeCount(), writesAtFailure);
			// Bytes already handed to the socket can still arrive after the response claimed failure.
			assert.ok(receivedBytes < bodySize);
			assert.strictEqual(nativeRequest?.writableEnded, false);
			assert.strictEqual(nativeRequest?.destroyed, false);
		} finally {
			release.resolve();
			await result;
		}

		const error = await result;
		assert.strictEqual(error, hookError);
		assert.ok(error instanceof HTTPError);
		assert.strictEqual(error.response.body, 'upload rejected');
	});
}

test('a buffered upload stops during an error hook and replays the complete same buffer on retry', withServer, async (t, server, got) => {
	const firstChunkReceived = Promise.withResolvers<void>();
	const body = Buffer.alloc(bodySize);
	let requests = 0;
	let firstBytes = 0;
	server.post('/', (request, response) => {
		requests++;
		const attempt = requests;
		request.on('error', () => {});
		let bytes = 0;
		const received: Uint8Array[] = [];
		request.on('data', (chunk: Uint8Array) => {
			bytes += chunk.byteLength;
			received.push(chunk);
			if (attempt === 1) {
				firstBytes += chunk.byteLength;
				firstChunkReceived.resolve();
			}
		});
		request.once('end', () => {
			assert.deepStrictEqual(Buffer.concat(received), body);
			response.end(String(bytes));
		});
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cause = Object.assign(new Error('Retryable upload observer failure'), {code: 'ECONNRESET'});
	const nativeRequests: Array<{request: ClientRequest; writeCount: () => number}> = [];
	const createRequest: RequestFunction = (url, options, callback) => {
		const request = http.request(url, options, callback);
		const write = t.mock.method(request, 'write');
		nativeRequests.push({request, writeCount: () => write.mock.calls.length});
		return request;
	};

	let failures = 0;
	let retries = 0;
	let bytesAtFailure = 0;
	const result = got.post('', {
		body,
		request: createRequest,
		retry: {limit: 1, methods: ['POST'], calculateDelay: () => 1},
		hooks: {
			beforeRetry: [async error => {
				retries++;
				assert.strictEqual(error.cause, cause);
				entered.resolve();
				await release.promise;
			}],
		},
	}).on('uploadProgress', progress => {
		if (failures === 0 && progress.transferred > 0) {
			failures++;
			bytesAtFailure = progress.transferred;
			throw cause;
		}
	}).text();
	try {
		await Promise.race([entered.promise, result.then(() => assert.fail('The upload must wait for its retry hook'))]);
		await firstChunkReceived.promise;
		await setImmediate();
		await setImmediate();
		assert.strictEqual(nativeRequests[0]?.writeCount(), 1);
		assert.strictEqual(nativeRequests[0]?.request.writableEnded, false);
		assert.strictEqual(nativeRequests[0]?.request.destroyed, false);
		assert.ok(firstBytes > 0);
		assert.ok(firstBytes <= bytesAtFailure);
	} finally {
		release.resolve();
	}

	assert.strictEqual(await result, String(bodySize));
	assert.strictEqual(requests, 2);
	assert.strictEqual(retries, 1);
	assert.strictEqual(failures, 1);
	assert.strictEqual(nativeRequests[0]?.request.destroyed, true);
});

for (const api of ['promise', 'stream']) {
	test(`a redirected ${api} buffered upload stops without ending the native request owned by an error hook`, withServer, async (t, server, got) => {
		server.post('/start', async (request, response) => {
			assert.strictEqual((await getStream(request)).length, bodySize);
			response.writeHead(307, {location: '/target'}).end();
		});
		const firstChunkReceived = Promise.withResolvers<void>();
		let receivedBytes = 0;
		server.post('/target', (request, response) => {
			request.on('error', () => {});
			request.on('data', (chunk: Uint8Array) => {
				receivedBytes += chunk.byteLength;
				firstChunkReceived.resolve();
			});
			request.once('end', () => {
				response.end('uploaded');
			});
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const cause = new Error('The redirected upload observer failed');
		let dispatches = 0;
		let nativeRequest: ClientRequest | undefined;
		let writeCount = () => 0;
		let successfulProgress = 0;
		let bytesAtFailure = 0;
		const createRequest: RequestFunction = (url, options, callback) => {
			dispatches++;
			const request = http.request(url, options, callback);
			const write = t.mock.method(request, 'write');
			writeCount = () => write.mock.calls.length;
			nativeRequest = request;
			return request;
		};

		const options = {
			body: Buffer.alloc(bodySize),
			request: createRequest,
			retry: {limit: 0},
			hooks: {
				beforeError: [async (error: RequestError) => {
					assert.strictEqual(error.cause, cause);
					entered.resolve();
					await release.promise;
					return error;
				}],
			},
		};
		const observe = (progress: {transferred: number; percent: number}) => {
			if (dispatches === 2) {
				if (progress.percent === 1) {
					successfulProgress++;
				}

				if (progress.transferred > 0) {
					bytesAtFailure = progress.transferred;
					throw cause;
				}
			}
		};

		const operation = api === 'promise'
			? got.post('start', options).on('uploadProgress', observe)
			: got.stream.post('start', options).on('uploadProgress', observe).toArray();
		const result = operation.catch((error: unknown) => error);
		try {
			await Promise.race([entered.promise, result.then(() => assert.fail('The upload must wait for its error hook'))]);
			await firstChunkReceived.promise;
			await setImmediate();
			await setImmediate();
			assert.strictEqual(dispatches, 2);
			assert.strictEqual(writeCount(), 1);
			assert.ok(receivedBytes > 0);
			assert.ok(receivedBytes <= bytesAtFailure);
			assert.strictEqual(nativeRequest?.writableEnded, false);
			assert.strictEqual(nativeRequest?.destroyed, false);
			assert.strictEqual(successfulProgress, 0);
		} finally {
			release.resolve();
			await result;
		}

		const error = await result;
		assert.ok(error instanceof RequestError);
		assert.strictEqual(error.cause, cause);
		assert.strictEqual(nativeRequest?.destroyed, true);
		assert.strictEqual(successfulProgress, 0);
	});
}

test('an HTTP/2 buffered upload stops while its progress error hook retains teardown ownership', async t => {
	const firstChunkReceived = Promise.withResolvers<void>();
	let receivedBytes = 0;
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.on('data', (chunk: Uint8Array) => {
			receivedBytes += chunk.byteLength;
			firstChunkReceived.resolve();
		});
	});
	t.after(server.close);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cause = new Error('The HTTP/2 upload observer failed');
	let nativeRequest: ClientRequest | undefined;
	let writeCount = () => 0;
	let bytesAtFailure = 0;
	const operation = got.post(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		body: Buffer.alloc(bodySize),
		retry: {limit: 0},
		hooks: {
			beforeError: [async error => {
				assert.strictEqual(error.cause, cause);
				entered.resolve();
				await release.promise;
				return error;
			}],
		},
	}).on('request', request => {
		nativeRequest = request;
		const write = t.mock.method(request, 'write');
		writeCount = () => write.mock.calls.length;
	}).on('uploadProgress', progress => {
		if (progress.transferred > 0) {
			bytesAtFailure = progress.transferred;
			throw cause;
		}
	});
	const result = operation.catch((error: unknown) => error);
	try {
		await Promise.race([entered.promise, result.then(() => assert.fail('The upload must wait for its error hook'))]);
		const writesAtFailure = writeCount();
		await firstChunkReceived.promise;
		await setImmediate();
		await setImmediate();
		assert.strictEqual(writeCount(), writesAtFailure);
		assert.ok(receivedBytes > 0);
		assert.ok(receivedBytes <= bytesAtFailure);
		assert.strictEqual(nativeRequest?.writableEnded, false);
		assert.strictEqual(nativeRequest?.destroyed, false);
	} finally {
		release.resolve();
		await result;
	}

	const error = await result;
	assert.ok(error instanceof RequestError);
	assert.strictEqual(error.cause, cause);
	assert.strictEqual(nativeRequest?.destroyed, true);
});
