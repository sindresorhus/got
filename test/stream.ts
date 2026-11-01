import process from 'node:process';
import {execFile} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {gzipSync} from 'node:zlib';
import fs from 'node:fs';
import http, {
	Agent as HttpAgent,
	IncomingMessage,
	ServerResponse,
	request as httpRequest,
	type ClientRequest,
} from 'node:http';
import http2 from 'node:http2';
import type net from 'node:net';
import {createServer, Socket} from 'node:net';
import stream, {Readable as ReadableStream, Writable} from 'node:stream';
import {finished, pipeline as streamPipeline} from 'node:stream/promises';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {promisify} from 'node:util';
import type {Handler} from 'express';
import getStream from 'get-stream';
import {Readable as Readable2} from 'readable-stream';
import is from '@sindresorhus/is';
import delay from 'delay';
import pem from 'pem';
import * as toughCookie from 'tough-cookie';
import {expectTypeOf} from 'expect-type';
import got, {HTTPError, RequestError, type Options} from '../source/index.js';
import type {PlainResponse, Response} from '../source/core/response.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import {onceValue} from './helpers/once-value.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import type {CreateCertificate} from './types/pem.js';

const createCertificate = promisify(pem.createCertificate as CreateCertificate);

test('an early redirect retires an ended native upload whose buffered bytes have not finished writing', withServer, async (t, targetServer, got) => {
	targetServer.get('/target', (_request, response) => {
		response.end('followed');
	});
	const sockets = new Set<Socket>();
	const redirectServer = createServer(socket => {
		sockets.add(socket);
		socket.once('data', () => {
			// Stop consuming the upload so end() cannot flush the remaining buffered bytes.
			socket.pause();
			socket.write(`HTTP/1.1 303 See Other\r\nLocation: ${targetServer.url}/target\r\nContent-Length: 0\r\n\r\n`);
		});
	});
	t.after(async () => {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>(resolve => {
			redirectServer.close(() => {
				resolve();
			});
		});
	});
	await new Promise<void>(resolve => {
		redirectServer.listen(0, '127.0.0.1', resolve);
	});
	const {port} = redirectServer.address() as net.AddressInfo;
	const requests: ClientRequest[] = [];
	const body = Buffer.alloc(16 * 1024 * 1024);
	let redirectUpload: {ended: boolean; finished: boolean} | undefined;
	const response = await got.post(`http://127.0.0.1:${port}/start`, {
		headers: {'content-length': String(body.byteLength)}, retry: {limit: 0}, timeout: {request: 5000},
		request(url, options, callback) {
			const request = httpRequest(url, options, callback);
			if (options.method === 'POST') {
				request.once('response', () => {
					redirectUpload = {ended: request.writableEnded, finished: request.writableFinished};
				});
			}

			request.end(options.method === 'POST' ? body : undefined);
			return request;
		},
		hooks: {
			beforeRedirect: [() => {
				assert.deepStrictEqual(redirectUpload, {ended: true, finished: false});
			}],
		},
	}).on('request', request => {
		requests.push(request);
	});
	assert.strictEqual(response.body, 'followed');
	assert.strictEqual(requests.length, 2);
	assert.strictEqual(requests[0]!.destroyed, true);
});

for (const uploadMethod of ['write', 'end', 'cork', 'pipeline']) {
	test(`an early redirect completes a public ${uploadMethod} after retiring its backpressured native write`, withServer, async (t, targetServer, got) => {
		targetServer.get('/target', (_request, response) => {
			response.end('followed');
		});
		const sockets = new Set<Socket>();
		const redirectServer = createServer(socket => {
			sockets.add(socket);
			socket.once('data', () => {
				socket.pause();
				socket.write(`HTTP/1.1 303 See Other\r\nLocation: ${targetServer.url}/target\r\nContent-Length: 0\r\n\r\n`);
			});
		});
		t.after(async () => {
			for (const socket of sockets) {
				socket.destroy();
			}

			await new Promise<void>(resolve => {
				redirectServer.close(() => {
					resolve();
				});
			});
		});
		await new Promise<void>(resolve => {
			redirectServer.listen(0, '127.0.0.1', resolve);
		});
		const {port} = redirectServer.address() as net.AddressInfo;
		const requests: ClientRequest[] = [];
		const request = got.stream.post(`http://127.0.0.1:${port}/start`, {retry: {limit: 0}, timeout: {request: 5000}}).on('request', nativeRequest => {
			requests.push(nativeRequest);
		});
		t.after(() => {
			request.destroy();
		});
		const response = getStream(request);
		const body = Buffer.alloc(16 * 1024 * 1024);
		let completion: Promise<void>;
		if (uploadMethod === 'pipeline') {
			completion = streamPipeline(ReadableStream.from([body]), request);
		} else {
			completion = finished(request, {cleanup: true});
			if (uploadMethod === 'write') {
				request.write(body);
				request.end();
			} else if (uploadMethod === 'cork') {
				request.cork();
				request.write(body.subarray(0, body.byteLength / 2));
				request.write(body.subarray(body.byteLength / 2));
				request.end();
			} else {
				request.end(body);
			}
		}

		assert.strictEqual((await Promise.all([response, completion]))[0], 'followed');
		assert.strictEqual(request.writableFinished, true);
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(requests[0]!.destroyed, true);
	});
}

for (const statusCode of [303, 307, 308]) {
	test(`an early ${statusCode} redirect releases the previous native request while an iterable read is pending`, withServer, async (t, server, got) => {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		t.after(() => {
			released.resolve();
		});
		server.post('/start', async (_request, response) => {
			await entered.promise;
			response.writeHead(statusCode, {location: '/target'}).end();
		});
		server.all('/target', async (request, response) => {
			response.end(await getStream(request));
		});
		let iterations = 0;
		const body = {
			async * [Symbol.asyncIterator]() {
				if (++iterations === 1) {
					yield 'first attempt';
					entered.resolve();
					await released.promise;
					return;
				}

				yield 'redirected upload';
			},
		};
		const requests: ClientRequest[] = [];
		const response = await got.post('start', {body, retry: {limit: 0}}).on('request', request => {
			requests.push(request);
		});
		assert.strictEqual(response.body, statusCode === 303 ? '' : 'redirected upload');
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(requests[0]!.destroyed, true);
		assert.strictEqual(requests[1]!.method, statusCode === 303 ? 'GET' : 'POST');
	});
}

test('a redirect after a completed upload retains the reusable connection', withServer, async (t, server, got) => {
	const agent = new HttpAgent({keepAlive: true, maxSockets: 1});
	t.after(() => {
		agent.destroy();
	});
	server.post('/start', async (request, response) => {
		assert.strictEqual(await getStream(request), 'replayable upload');
		response.writeHead(307, {location: '/target'}).end();
	});
	server.post('/target', async (request, response) => {
		response.end(await getStream(request));
	});
	const requests: ClientRequest[] = [];
	const sockets: Array<ClientRequest['socket']> = [];
	const response = await got.post('start', {
		body: 'replayable upload', agent: {http: agent}, retry: {limit: 0},
		hooks: {
			beforeRedirect: [() => {
				assert.strictEqual(requests[0]!.writableEnded, true);
				assert.strictEqual(requests[0]!.destroyed, false);
			}],
		},
	}).on('request', request => {
		requests.push(request);
		request.once('socket', socket => {
			sockets.push(socket);
		});
	});
	assert.strictEqual(response.body, 'replayable upload');
	assert.strictEqual(requests.length, 2);
	assert.strictEqual(sockets.length, 2);
	assert.strictEqual(sockets[0], sockets[1]);
});

test('an early HTTP/2 redirect closes the pending upload stream and retains a usable session', async t => {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	let cancelledStream: http2.ServerHttp2Stream | undefined;
	const server = await createHttp2TestServer((stream, headers) => {
		if (headers[':path'] === '/start') {
			cancelledStream = stream;
			stream.once('close', () => {
				closed.resolve();
			});
			void entered.promise.then(() => {
				stream.respond({':status': 307, location: '/target'});
				stream.end();
			});
			return;
		}

		stream.respond({':status': 200});
		stream.end(headers[':path'] === '/target' ? 'redirected' : 'follow-up');
	});
	t.after(async () => {
		released.resolve();
		await server.close();
	});
	server.server.updateSettings({maxConcurrentStreams: 1});
	let iterations = 0;
	const body = {
		async * [Symbol.asyncIterator]() {
			if (++iterations === 1) {
				yield 'first attempt';
				entered.resolve();
				await released.promise;
				return;
			}

			yield 'redirected upload';
		},
	};
	const requests: ClientRequest[] = [];
	const options = {
		http2: true, https: {rejectUnauthorized: false}, retry: {limit: 0}, timeout: {request: 5000},
	};
	assert.strictEqual(await got.post(`${server.url}/start`, {...options, body}).on('request', request => {
		requests.push(request);
	}).text(), 'redirected');
	await closed.promise;
	assert.strictEqual(requests.length, 2);
	assert.strictEqual(requests[0]!.destroyed, true);
	assert.strictEqual(requests[0]!.writableEnded, false);
	assert.strictEqual(cancelledStream?.closed, true);
	assert.strictEqual(await got(`${server.url}/follow-up`, options).text(), 'follow-up');
});

test('an exhausted iterator from a replayable factory is not closed again', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	let returnCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					return {done: true as const, value: undefined};
				},
				async return() {
					returnCalls++;
					return {done: true as const, value: undefined};
				},
			};
		},
	};
	assert.strictEqual(await got.post('', {body}).text(), '');
	assert.strictEqual(returnCalls, 0);
});

test('a null async iterator method retains the synchronous iterator fallback', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	const body = {
		[Symbol.asyncIterator]: null, * [Symbol.iterator]() {
			yield 'synchronous fallback';
		},
	};
	assert.strictEqual(await got.post('', {body}).text(), 'synchronous fallback');
});

test('cancellation inside an iterator factory closes the acquired iterator before reading it', withServer, async (_t, _server, got) => {
	const controller = new AbortController();
	let returnCalls = 0;
	let nextCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			controller.abort();
			return {
				next() {
					nextCalls++;
					return new Promise<IteratorResult<string>>(() => {});
				},
				async return() {
					returnCalls++;
					return {done: true as const, value: undefined};
				},
			};
		},
	};
	await assert.rejects(got.post('', {body, signal: controller.signal, retry: {limit: 0}}), {code: 'ERR_ABORTED'});
	assert.strictEqual(returnCalls, 1);
	assert.strictEqual(nextCalls, 0);
});

test('cancelling a replayable async iterable closes its active iterator while next is pending', withServer, async (_t, _server, got) => {
	const entered = Promise.withResolvers<void>();
	const controller = new AbortController();
	let returnCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					entered.resolve();
					return new Promise<IteratorResult<string>>(() => {});
				},
				async return() {
					returnCalls++;
					return {done: true as const, value: undefined};
				},
			};
		},
	};
	const request = got.post('', {body, signal: controller.signal, retry: {limit: 0}});
	const rejected = assert.rejects(request, {code: 'ERR_ABORTED'});
	await entered.promise;
	controller.abort();
	await rejected;
	assert.strictEqual(returnCalls, 1);
});

test('late iterator results after cancellation do not close the iterator twice', withServer, async (_t, _server, got) => {
	const entered = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<IteratorResult<string>>();
	const controller = new AbortController();
	let returnCalls = 0;
	let factoryReturnCalls = 0;
	let nextCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					nextCalls++;
					entered.resolve();
					return pending.promise;
				},
				async return() {
					returnCalls++;
					return {done: true as const, value: undefined};
				},
			};
		},
		return() {
			factoryReturnCalls++;
			return {done: true as const, value: undefined};
		},
	};
	const request = got.post('', {body, signal: controller.signal, retry: {limit: 0}});
	const rejected = assert.rejects(request, {code: 'ERR_ABORTED'});
	await entered.promise;
	controller.abort();
	await rejected;
	pending.resolve({done: false, value: 'late data'});
	await delay(0);
	assert.strictEqual(returnCalls, 1);
	assert.strictEqual(factoryReturnCalls, 0);
	assert.strictEqual(nextCalls, 1);
});

test('cancelling a synchronous iterable closes its separate active iterator once', withServer, async (_t, _server, got) => {
	const controller = new AbortController();
	let returnCalls = 0;
	let nextCalls = 0;
	const body = {
		[Symbol.iterator]() {
			return {
				next() {
					nextCalls++;
					return {done: false, value: 'chunk'};
				},
				return() {
					returnCalls++;
					return {done: true as const, value: undefined};
				},
			};
		},
	};
	const request = got.post('', {body, signal: controller.signal, retry: {limit: 0}}).on('uploadProgress', progress => {
		if (progress.transferred > 0) {
			controller.abort();
		}
	});
	await assert.rejects(request, {code: 'ERR_ABORTED'});
	assert.strictEqual(returnCalls, 1);
	assert.strictEqual(nextCalls, 1);
});

test('iterator cleanup failures do not replace a failure from next', withServer, async (_t, _server, got) => {
	const cause = new Error('Source failed');
	let returnCalls = 0;
	const body = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<string>> {
					throw cause;
				},
				async return(): Promise<IteratorResult<string>> {
					returnCalls++;
					throw new Error('Cleanup failed');
				},
			};
		},
	};
	const error = await rejects(got.post('', {body, retry: {limit: 0}}));
	assert.strictEqual(error.code, 'ERR_UPLOAD');
	assert.strictEqual(error.cause, cause);
	assert.strictEqual(returnCalls, 1);
});

for (const throws of [false, true]) {
	test(`a ${throws ? 'throwing' : 'working'} iterator return getter preserves cancellation and releases the request`, withServer, async (_t, _server, got) => {
		const entered = Promise.withResolvers<void>();
		const controller = new AbortController();
		let nativeRequest: ClientRequest | undefined;
		let cleanupReads = 0;
		let cleanupCalls = 0;
		const body = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						entered.resolve();
						return new Promise<IteratorResult<string>>(() => {});
					},
					get return() {
						cleanupReads++;
						if (throws) {
							throw new Error('Cleanup getter failed');
						}

						return async () => {
							cleanupCalls++;
							return {done: true as const, value: undefined};
						};
					},
				};
			},
		};
		const request = got.post('', {body, signal: controller.signal, retry: {limit: 0}}).on('request', request => {
			nativeRequest = request;
		});
		const rejected = assert.rejects(request, {code: 'ERR_ABORTED'});
		await entered.promise;
		controller.abort();
		await rejected;
		assert.strictEqual(cleanupReads, 1);
		assert.strictEqual(cleanupCalls, throws ? 0 : 1);
		assert.strictEqual(nativeRequest?.destroyed, true);
	});
}

test('a late result from a redirected iterator cannot close the fresh iterator', withServer, async (_t, server, got) => {
	server.post('/start', (request, response) => {
		request.resume();
		response.writeHead(307, {location: '/target', connection: 'close'}).end();
	});
	server.post('/target', request => {
		request.resume();
	});
	const secondEntered = Promise.withResolvers<void>();
	const pending = [Promise.withResolvers<IteratorResult<string>>(), Promise.withResolvers<IteratorResult<string>>()];
	const returnCalls = [0, 0];
	let iteration = 0;
	const controller = new AbortController();
	const body = {
		[Symbol.asyncIterator]() {
			const index = iteration++;
			let sent = false;
			return {
				async next() {
					if (!sent) {
						sent = true;
						return {done: false as const, value: 'first chunk'};
					}

					if (index === 1) {
						secondEntered.resolve();
					}

					return pending[index]!.promise;
				},
				async return() {
					returnCalls[index]!++;
					return {done: true as const, value: undefined};
				},
			};
		},
	};
	const request = got.post('start', {body, signal: controller.signal, retry: {limit: 0}});
	const rejected = assert.rejects(request, {code: 'ERR_ABORTED'});
	try {
		await secondEntered.promise;
		assert.deepStrictEqual(returnCalls, [1, 0]);
		pending[0]!.resolve({done: false, value: 'late old chunk'});
		await delay(0);
		assert.deepStrictEqual(returnCalls, [1, 0]);
	} finally {
		controller.abort();
		for (const next of pending) {
			next.resolve({done: true, value: undefined});
		}

		await rejected;
	}

	assert.deepStrictEqual(returnCalls, [1, 1]);
});

for (const asynchronous of [false, true]) {
	test(`${asynchronous ? 'async' : 'sync'} iterator promise chunks keep their language semantics`, withServer, async (_t, server, got) => {
		server.post('/', async (request, response) => {
			response.end(await getStream(request));
		});
		let sent = false;
		let returnCalls = 0;
		const iterator = {
			next() {
				if (sent) {
					return {done: true as const, value: undefined};
				}

				sent = true;
				return {done: false as const, value: Promise.resolve('body')};
			},
			return() {
				returnCalls++;
				return {done: true as const, value: undefined};
			},
		};
		const body = asynchronous
			? {
				[Symbol.asyncIterator]: () => ({
					async next() {
						return iterator.next();
					},
					async return() {
						return iterator.return();
					},
				}),
			}
			: {[Symbol.iterator]: () => iterator};
		const request = got.post('', {body, retry: {limit: 0}});
		if (asynchronous) {
			await assert.rejects(request, {code: 'ERR_INVALID_ARG_TYPE'});
		} else {
			assert.strictEqual(await request.text(), 'body');
		}

		assert.strictEqual(returnCalls, asynchronous ? 1 : 0);
	});
}

for (const [description, cleanupExpression, expectedObservations] of [
	['cross-realm cleanup rejections', 'vm.runInNewContext(\'Promise.reject(new Error("foreign cleanup rejection"))\')', 0],
	['native cleanup rejections', 'Promise.reject(new Error("native cleanup rejection"))', 0],
	['delayed cleanup rejections', 'new Promise((_resolve, reject) => {void setImmediate().then(() => {reject(new Error("delayed cleanup rejection"));});})', 0],
	['rejecting cleanup thenables', '({then(_resolve, reject) {cleanupObservations++; reject(new Error("thenable cleanup rejection"));}})', 1],
	['throwing cleanup then getters', 'Object.defineProperty({}, "then", {get() {cleanupObservations++; throw new Error("then getter failure");}})', 1],
	['synchronous cleanup failures', '(() => {throw new Error("synchronous cleanup failure");})()', 0],
	['synchronous cleanup results', '({done: true, value: undefined})', 0],
] as const) {
	for (const useFactory of [false, true]) {
		test(`cancelled ${useFactory ? 'factory' : 'iterator'} uploads observe ${description}`, withServer, async (_t, server) => {
			// A child process detects a rejection that escapes after the request has already settled.
			const script = `
		import assert from 'node:assert/strict';
		import vm from 'node:vm';
		import {setImmediate} from 'node:timers/promises';
		import got from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
		const controller = new AbortController();
		let cleanupCalls = 0;
		let cleanupObservations = 0;
		const iterator = {
			[Symbol.asyncIterator]() {return this;},
			next() {
				queueMicrotask(() => {controller.abort();});
				return new Promise(() => {});
			},
			return() {
				cleanupCalls++;
				return ${cleanupExpression};
			},
		};
		const body = ${useFactory ? '{[Symbol.asyncIterator]() {return iterator;}}' : 'iterator'};
		await assert.rejects(got.post(process.argv[1], {body, signal: controller.signal, retry: {limit: 0}}), {code: 'ERR_ABORTED'});
		await setImmediate();
		await setImmediate();
		assert.strictEqual(cleanupCalls, 1);
		assert.strictEqual(cleanupObservations, ${expectedObservations});
	`;
			await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url]);
		});
	}
}

const defaultHandler: Handler = (_request, response) => {
	response.writeHead(200, {
		unicorn: 'rainbow',
		'content-encoding': 'gzip',
	});
	response.end(Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64')); // 'ok'
};

const redirectHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/',
	});
	response.end();
};

const postHandler: Handler = async (request, response) => {
	await streamPipeline(request, response);
};

const errorHandler: Handler = (_request, response) => {
	response.statusCode = 404;
	response.end();
};

const headersHandler: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

const infiniteHandler: Handler = (_request, response) => {
	response.write('foobar');
};

for (const operation of ['write', 'end']) {
	for (const [failure, expectedErrorCode] of [
		['aborting', 'ERR_ABORTED'],
		['destroying', 'ERR_STREAM_DESTROYED'],
		['destroying with an error', undefined],
		['failing', 'ERR_GOT_REQUEST_ERROR'],
	] as const) {
		test(`${failure} during initialization settles queued ${operation} callbacks`, withServer, async (t, _server, got) => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			t.after(() => {
				release.resolve();
			});
			const controller = new AbortController();
			const cause = new Error('initialization failed');
			const request = got.stream.post('', {
				signal: controller.signal,
				retry: {limit: 0},
				hooks: {
					beforeRequest: [async () => {
						started.resolve();
						await release.promise;
						if (failure === 'failing') {
							throw cause;
						}
					}],
				},
			});
			const errors: Error[] = [];
			request.on('error', error => {
				errors.push(error);
			});
			const closed = new Promise<void>(resolve => {
				request.once('close', resolve);
			});
			const callbacks: Array<{chunk: string; error: unknown}> = [];
			if (operation === 'write') {
				for (const chunk of ['first', 'second']) {
					request.write(chunk, error => {
						callbacks.push({chunk, error});
					});
				}
			} else {
				request.end((error?: Error) => {
					callbacks.push({chunk: 'end', error});
				});
			}

			await started.promise;
			switch (failure) {
				case 'aborting': {
					controller.abort();
					break;
				}

				case 'destroying': {
					request.destroy();
					break;
				}

				case 'destroying with an error': {
					request.destroy(cause);
					break;
				}

				case 'failing': {
					release.resolve();
					break;
				}
			}

			await closed;

			assert.deepStrictEqual(callbacks.map(({chunk}) => chunk), operation === 'write' ? ['first', 'second'] : ['end']);
			for (const {error} of callbacks) {
				assert.ok(error instanceof Error);
				assert.strictEqual((error as NodeJS.ErrnoException).code, expectedErrorCode);
			}

			if (failure === 'destroying with an error') {
				assert.ok(errors[0] instanceof RequestError);
				assert.strictEqual(errors[0].cause, cause);
				assert.strictEqual(errors.length, 1);
				for (const {error} of callbacks) {
					assert.strictEqual(error, cause);
				}
			} else {
				assert.deepStrictEqual(errors, failure === 'destroying' ? [] : [callbacks[0]!.error]);
			}

			assert.strictEqual(request.writableLength, 0);
		});
	}
}

test('aborting from a queued synthetic write callback settles each callback once', withServer, async (_t, _server, got) => {
	const response = new IncomingMessage(new Socket());
	response.statusCode = 200;
	response.complete = true;
	response.push(Buffer.from('synthetic'));
	response.push(null);
	const controller = new AbortController();
	const request = got.stream.post('', {signal: controller.signal, request: () => response});
	const errors: Error[] = [];
	request.on('error', error => {
		errors.push(error);
	});
	const closed = new Promise<void>(resolve => {
		request.once('close', resolve);
	});
	const callbacks: Array<{chunk: string; error: unknown}> = [];
	request.write('first', error => {
		callbacks.push({chunk: 'first', error});
		controller.abort();
	});
	request.write('second', error => {
		callbacks.push({chunk: 'second', error});
	});
	await closed;

	assert.deepStrictEqual(callbacks.map(({chunk}) => chunk), ['first', 'second']);
	assert.ifError(callbacks[0]!.error);
	assert.strictEqual(callbacks[1]!.error, errors[0]);
	assert.strictEqual((errors[0] as RequestError).code, 'ERR_ABORTED');
	assert.strictEqual(errors.length, 1);
	assert.strictEqual(request.writableLength, 0);
	assert.strictEqual(response.destroyed, true);
});

for (const syntheticResponse of [false, true]) {
	test(`queued writes and callback writes finish in order with a ${syntheticResponse ? 'synthetic' : 'native'} response`, withServer, async (t, server, got) => {
		server.post('/', async (request, response) => {
			response.end(await getStream(request));
		});

		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const callbacks: string[] = [];
		const request = got.stream.post('', {
			hooks: {
				beforeRequest: [async () => {
					hookStarted.resolve();
					await releaseHook.promise;
					if (syntheticResponse) {
						const response = new IncomingMessage(new Socket());
						response.statusCode = 200;
						response.complete = true;
						response.push(Buffer.from('synthetic'));
						response.push(null);
						return response;
					}

					return undefined;
				}],
			},
		});
		t.after(() => {
			releaseHook.resolve();
			request.destroy();
		});
		const body = getStream(request);
		const finished = once(request, 'finish');
		await hookStarted.promise;
		request.write('first', error => {
			assert.ifError(error);
			callbacks.push('first');
			request.end('third', () => {
				callbacks.push('third');
			});
		});
		request.write('second', error => {
			assert.ifError(error);
			callbacks.push('second');
		});
		releaseHook.resolve();

		assert.strictEqual(await body, syntheticResponse ? 'synthetic' : 'firstsecondthird');
		await finished;
		assert.deepStrictEqual(callbacks, ['first', 'second', 'third']);
		assert.strictEqual(request.writableFinished, true);
	});
}

// A local request needs milliseconds. The watchdog only exists so a hang reports this message
// rather than AVA's generic timeout, so it is set well clear of any plausible delay.
async function expectStreamToEnd(stream: NodeJS.ReadableStream & NodeJS.EventEmitter): Promise<void> {
	await Promise.race([
		new Promise<void>((resolve, reject) => {
			stream.on('error', reject);
			stream.on('end', resolve);
			stream.resume();
		}),
		(async () => {
			await delay(5000);
			throw new Error('Timed out waiting for stream end');
		})(),
	]);
}

test('piping into an invalid request preserves the original request error', async _t => {
	const request = got.stream.post('not a URL');
	const source = ReadableStream.from(['payload']);
	const destination = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});

	await assert.rejects(streamPipeline(source, request, destination), errorMatching(RequestError, {code: 'ERR_INVALID_URL'}));
});

test('stream reads a cookie and completes', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end('body');
	});

	const cookieJar = new toughCookie.CookieJar();

	await assert.doesNotReject(expectStreamToEnd(got.stream({cookieJar})));

	const cookie = cookieJar.getCookiesSync(server.url)[0];
	assert.strictEqual(cookie?.key, 'hello');
	assert.strictEqual(cookie?.value, 'world');
});

test('stream reads a cookie and completes after async cookie jar write', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end('body');
	});

	const events: string[] = [];
	let storedCookie = '';
	const cookieJar = {
		async getCookieString() {
			return '';
		},
		async setCookie(rawCookie: string) {
			await delay(50);
			storedCookie = rawCookie;
			events.push('cookie');
		},
	};

	const request = got.stream({cookieJar});
	request.on('response', () => {
		events.push('response');
	});
	request.once('data', () => {
		events.push('data');
	});
	request.on('end', () => {
		events.push('end');
	});

	const body = await getStream(request);

	assert.strictEqual(body, 'body');
	assert.strictEqual(storedCookie, 'hello=world');
	assert.deepStrictEqual(events, ['cookie', 'response', 'data', 'end']);
});

test('stream follows redirect after storing redirect cookies', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? '');
	});

	const cookieJar = new toughCookie.CookieJar();

	assert.strictEqual(await getStream(got.stream('redirect', {cookieJar})), 'hello=world');
});

test('reusedSocket getter', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const agent = new HttpAgent({keepAlive: true});

	const stream = got.stream('', {agent: {http: agent}});
	assert.strictEqual(stream.reusedSocket, undefined);

	await once(stream, 'response');

	stream.resume();
	await once(stream, 'end');

	assert.strictEqual(stream.reusedSocket, false);

	const secondStream = got.stream('', {agent: {http: agent}});
	secondStream.resume();
	await once(secondStream, 'end');

	assert.strictEqual(secondStream.reusedSocket, true);
});

test('`options.responseType` is ignored', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	await assert.doesNotReject(getStream(got.stream({responseType: 'json'})));
});

test('returns readable stream', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const data = await getStream(got.stream(''));
	assert.strictEqual(data, 'ok');
});

test('returns writeable stream', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post('');
	const promise = getStream(stream);
	stream.end('wow');

	assert.strictEqual(await promise, 'wow');
});

test('does not throw if using stream and passing a json option', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	await assert.doesNotReject(getStream(got.stream.post({json: {}})));
});

test('does not throw if using stream and passing a form option', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	await assert.doesNotReject(getStream(got.stream.post({form: {}})));
});

test('has request event', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	const request = await onceValue<ClientRequest>(stream, 'request');
	assert.ok(request);
	assert.strictEqual(request.method, 'GET');

	await getStream(stream);
});

test('has redirect event', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const stream = got.stream('redirect');
	const [, {headers}] = await once(stream, 'redirect') as unknown as [unknown, {headers: Record<string, string>}];
	assert.strictEqual(headers.location, '/');

	await getStream(stream);
});

test('redirect event passes the updated options first and the response second', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	let redirectCount = 0;
	const request = got('redirect').on('redirect', (updatedOptions, response) => {
		redirectCount += 1;
		expectTypeOf(updatedOptions).toEqualTypeOf<Options>();
		expectTypeOf(response).toEqualTypeOf<PlainResponse>();
		assert.strictEqual(new URL(updatedOptions.url!).pathname, '/');
		assert.strictEqual(response.statusCode, 302);
	});

	await request;

	assert.strictEqual(redirectCount, 1);
});

test('follows invalid compressed redirects without decompressing the redirect body', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('target-ok');
	});

	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
			'content-encoding': 'gzip',
		});
		response.end('not-a-valid-gzip-stream');
	});

	assert.strictEqual(await getStream(got.stream('redirect', {
		retry: {
			limit: 0,
		},
	})), 'target-ok');
});

test('has response event', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	const [{statusCode}] = await once(got.stream(''), 'response') as unknown as [Response];
	assert.strictEqual(statusCode, 200);
});

test('has error event', withServer, async (_t, server, got) => {
	server.get('/', errorHandler);

	const stream = got.stream('');
	await assert.rejects(once(stream, 'response'), errorMatching(HTTPError, {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v}));
});

test('has error event #2', async _t => {
	const stream = got.stream('http://doesntexist');
	const error = await rejects(once(stream, 'response'));
	assert.match(error!.code, /ENOTFOUND|EAI_AGAIN/v);
});

test('validation errors can be caught with synchronous error handler', withServer, async (_t, _server, got) => {
	const stream = got.stream('', {
		// @ts-expect-error - Testing invalid option
		meaningless: 'option',
	});

	const error: any = await new Promise((resolve, reject) => {
		// Attach error handler immediately (synchronously)
		stream.on('error', error => {
			resolve(error);
		});

		// Timeout in case error is never emitted
		setTimeout(() => {
			reject(new Error('Error was not emitted'));
		}, 1000);
	});

	assert.strictEqual(error instanceof Error, true);
	assert.match(error.message, /Unexpected option: meaningless/v);
});

test('has response event if `options.throwHttpErrors` is false', withServer, async (_t, server, got) => {
	server.get('/', errorHandler);

	const [{statusCode}] = await once(got.stream({throwHttpErrors: false}), 'response') as unknown as [Response];
	assert.strictEqual(statusCode, 404);
});

test('accepts `options.body` as a Stream', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({body: ReadableStream.from('wow')});
	assert.strictEqual(await getStream(stream), 'wow');
});

test('redirect response contains old url', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const [{requestUrl}] = await once(got.stream('redirect'), 'response') as unknown as [Response];
	assert.strictEqual(requestUrl.toString(), `${server.url}/redirect`);
});

test('check for pipe method', withServer, (_t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	assert.strictEqual(is.function(stream.pipe), true);
	assert.strictEqual(is.function(stream.on('foobar', () => {}).pipe), true);

	stream.destroy();
});

test('piping works', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);

	assert.strictEqual(await getStream(got.stream('')), 'ok');
	assert.strictEqual(await getStream(got.stream('').on('foobar', () => {})), 'ok');
});

test('proxying headers works', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		await streamPipeline(
			got.stream(''),
			response,
		);
	});

	const {headers, body} = await got('proxy');
	assert.strictEqual(headers.unicorn, 'rainbow');
	assert.strictEqual(headers['content-encoding'], undefined);
	assert.strictEqual(headers['content-length'], undefined);
	assert.strictEqual(body, 'ok');
});

test('piping server request to Got does not proxy headers by default', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream(''),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			foo: 'bar',
		},
	}).json();
	assert.strictEqual(headers.foo, undefined);
	assert.ok(headers['user-agent']); // Got's default user-agent should still be present
});

test('piping server request to Got proxies headers when copyPipedHeaders is true', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream('', {copyPipedHeaders: true}),
			response,
		);
	});

	const {foo}: {foo: string} = await got('proxy', {
		headers: {
			foo: 'bar',
		},
	}).json();
	assert.strictEqual(foo, 'bar');
});

test('copyPipedHeaders does not forward hop-by-hop or connection-listed headers', withServer, async (t, server, got) => {
	await withServer(t, async (_t, upstreamServer) => {
		upstreamServer.get('/', headersHandler);
		upstreamServer.post('/', headersHandler);

		server.post('/proxy', async (request, response) => {
			await streamPipeline(
				request,
				got.stream(`http://localhost:${upstreamServer.port}/`, {copyPipedHeaders: true}),
				response,
			);
		});

		const proxiedResponse = await new Promise<{statusCode: number | undefined; body: string}>((resolve, reject) => {
			const request = httpRequest(`${server.url}/proxy`, {
				method: 'POST',
				headers: {
					connection: 'keep-alive, x-internal-auth',
					'proxy-connection': 'keep-alive, x-proxy-internal-auth',
					'x-internal-auth': '1',
					'x-proxy-internal-auth': '1',
					'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
					foo: 'bar',
					'content-type': 'text/plain',
				},
			}, response => {
				const chunks: Uint8Array[] = [];

				response.on('data', chunk => {
					chunks.push(Buffer.from(chunk));
				});

				response.on('end', () => {
					resolve({
						statusCode: response.statusCode,
						body: Buffer.concat(chunks).toString(),
					});
				});
			});

			request.on('error', reject);
			request.end('hello');
		});

		assert.strictEqual(proxiedResponse.statusCode, 200);

		const headers = JSON.parse(proxiedResponse.body) as Record<string, string | undefined>;
		assert.strictEqual(headers.foo, 'bar');
		assert.strictEqual(headers['x-internal-auth'], undefined);
		assert.strictEqual(headers['x-proxy-internal-auth'], undefined);
		assert.strictEqual(headers['proxy-authorization'], undefined);
		assert.strictEqual(headers.connection?.includes('x-internal-auth') ?? false, false);
		assert.strictEqual(headers['proxy-connection']?.includes('x-proxy-internal-auth') ?? false, false);
	});
});

test('copyPipedHeaders does not forward credential headers', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		request.resume();
		await once(request, 'end');
		response.end(JSON.stringify(request.headers));
	});

	const source = ReadableStream.from(['hello']) as ReadableStream & {headers: Record<string, string>};
	source.headers = {};
	source.headers.Authorization = 'Bearer client-secret';
	source.headers.Cookie = 'session=client-secret';
	source.headers.Cookie2 = 'legacy=client-secret';
	source.headers['Set-Cookie'] = 'session=response-secret';
	source.headers['Set-Cookie2'] = 'legacy=response-secret';
	source.headers['X-Safe-Header'] = 'forward-me';

	const responseBody = await getStream(source.pipe(got.stream.post('', {copyPipedHeaders: true})));
	const headers = JSON.parse(responseBody) as Record<string, string | undefined>;

	assert.strictEqual(headers.authorization, undefined);
	assert.strictEqual(headers.cookie, undefined);
	assert.strictEqual(headers.cookie2, undefined);
	assert.strictEqual(headers['set-cookie'], undefined);
	assert.strictEqual(headers['set-cookie2'], undefined);
	assert.strictEqual(headers['x-safe-header'], 'forward-me');
});

test('explicit credential headers are preserved when copyPipedHeaders is true', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		request.resume();
		await once(request, 'end');
		response.end(JSON.stringify(request.headers));
	});

	const source = ReadableStream.from(['hello']) as ReadableStream & {headers: Record<string, string>};
	source.headers = {
		authorization: 'Bearer piped-secret',
		cookie: 'session=piped-secret',
		cookie2: 'legacy=piped-secret',
	};

	const responseBody = await getStream(source.pipe(got.stream.post('', {
		copyPipedHeaders: true,
		headers: {
			authorization: 'Bearer trusted',
			cookie: 'session=trusted',
			cookie2: 'legacy=trusted',
		},
	})));
	const headers = JSON.parse(responseBody) as Record<string, string | undefined>;

	assert.strictEqual(headers.authorization, 'Bearer trusted');
	assert.strictEqual(headers.cookie, 'session=trusted');
	assert.strictEqual(headers.cookie2, 'legacy=trusted');
});

test('copyPipedHeaders does not forward host', withServer, async (t, server, got) => {
	await withServer(t, async (_t, upstreamServer) => {
		upstreamServer.get('/', (request, response) => {
			response.end(String(request.headers.host));
		});

		server.get('/proxy', async (request, response) => {
			await streamPipeline(
				request,
				got.stream(`http://localhost:${upstreamServer.port}/`, {
					copyPipedHeaders: true,
					throwHttpErrors: false,
				}),
				response,
			);
		});

		const proxiedResponse = await new Promise<{statusCode: number | undefined; body: string}>((resolve, reject) => {
			const request = httpRequest(`${server.url}/proxy`, {
				method: 'GET',
				headers: {
					host: 'admin.internal',
				},
			}, response => {
				const chunks: Uint8Array[] = [];

				response.on('data', chunk => {
					chunks.push(Buffer.from(chunk));
				});

				response.on('end', () => {
					resolve({
						statusCode: response.statusCode,
						body: Buffer.concat(chunks).toString(),
					});
				});
			});

			request.on('error', reject);
			request.end();
		});

		assert.strictEqual(proxiedResponse.statusCode, 200);
		assert.strictEqual(proxiedResponse.body, `localhost:${upstreamServer.port}`);
	});
});

test('copyPipedHeaders does not forward headers nominated by mixed-case connection headers', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		request.resume();
		await once(request, 'end');
		response.end(JSON.stringify(request.headers));
	});

	const connectionHeader = 'Connection';
	const proxyConnectionHeader = 'Proxy-Connection';
	const internalHeader = 'X-Internal-Auth';
	const proxyInternalHeader = 'X-Proxy-Internal-Auth';
	const fooHeader = 'Foo';
	const source = ReadableStream.from(['hello']) as ReadableStream & {headers: Record<string, string>};
	source.headers = {};
	source.headers[connectionHeader] = 'keep-alive, X-Internal-Auth';
	source.headers[proxyConnectionHeader] = 'keep-alive, X-Proxy-Internal-Auth';
	source.headers[internalHeader] = '1';
	source.headers[proxyInternalHeader] = '1';
	source.headers[fooHeader] = 'bar';

	const responseBody = await getStream(source.pipe(got.stream.post('', {copyPipedHeaders: true})));
	const headers = JSON.parse(responseBody) as Record<string, string | undefined>;

	assert.strictEqual(headers.foo, 'bar');
	assert.strictEqual(headers['x-internal-auth'], undefined);
	assert.strictEqual(headers['x-proxy-internal-auth'], undefined);
});

test('piping server request to Got does not proxy headers when copyPipedHeaders is false', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream('', {copyPipedHeaders: false}),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			foo: 'bar',
		},
	}).json();
	assert.strictEqual(headers.foo, undefined);
	assert.ok(headers['user-agent']); // Got's default user-agent should still be present
});

test('explicit headers are not overwritten by piped headers when copyPipedHeaders is true', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream('', {
				copyPipedHeaders: true,
				headers: {
					'x-custom': 'explicit-value',
				},
			}),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'x-custom': 'piped-value',
		},
	}).json();
	assert.strictEqual(headers['x-custom'], 'explicit-value');
});

test('headers from extended defaults are not overwritten by piped headers when copyPipedHeaders is true', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);

	const gotWithDefaultHeaders = got.extend({
		headers: {
			'x-custom': 'default-explicit-value',
		},
	});

	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			gotWithDefaultHeaders.stream('', {
				copyPipedHeaders: true,
			}),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'x-custom': 'piped-value',
		},
	}).json();
	assert.strictEqual(headers['x-custom'], 'default-explicit-value');
});

test('explicitly omitted headers are not backfilled by piped headers when copyPipedHeaders is true', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream('', {
				copyPipedHeaders: true,
				headers: {
					foo: undefined,
				},
			}),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			foo: 'piped-value',
		},
	}).json();
	assert.strictEqual(headers.foo, undefined);
});

test('headers set by mutating stream options are not overwritten by piped headers', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		const gotStream = got.stream('', {copyPipedHeaders: true});
		gotStream.options.headers['x-custom'] = 'explicit-value';

		await streamPipeline(
			request,
			gotStream,
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'x-custom': 'piped-value',
		},
	}).json();
	assert.strictEqual(headers['x-custom'], 'explicit-value');
});

test('mixed-case headers set by mutating stream options are not overwritten by piped headers', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		const gotStream = got.stream('', {copyPipedHeaders: true});
		gotStream.options.headers.Authorization = 'Bearer explicit-token';

		await streamPipeline(
			request,
			gotStream,
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			authorization: 'Bearer piped-token',
		},
	}).json();
	assert.strictEqual(headers.authorization, 'Bearer explicit-token');
});

test('mixed-case headers omitted by mutating stream options are not backfilled by piped headers', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		const gotStream = got.stream('', {copyPipedHeaders: true});
		gotStream.options.headers.Authorization = undefined;

		await streamPipeline(
			request,
			gotStream,
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			authorization: 'Bearer piped-token',
		},
	}).json();
	assert.strictEqual(headers.authorization, undefined);
});

test('headers omitted by mutating stream options are not backfilled by piped headers', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		const gotStream = got.stream('', {copyPipedHeaders: true});
		gotStream.options.headers.authorization = undefined;

		await streamPipeline(
			request,
			gotStream,
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			authorization: 'Bearer piped-token',
		},
	}).json();
	assert.strictEqual(headers.authorization, undefined);
});

test('deleted explicit headers can be backfilled by piped headers', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		const gotStream = got.stream('', {
			copyPipedHeaders: true,
			headers: {
				'x-custom': 'explicit-value',
			},
		});
		delete gotStream.options.headers['x-custom'];

		await streamPipeline(
			request,
			gotStream,
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'x-custom': 'piped-value',
		},
	}).json();
	assert.strictEqual(headers['x-custom'], 'piped-value');
});

test('explicit user-agent header is not overwritten by piped header', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream('', {
				copyPipedHeaders: true,
				headers: {
					'user-agent': 'got (https://github.com/sindresorhus/got)',
				},
			}),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'user-agent': 'piped-user-agent',
		},
	}).json();
	assert.strictEqual(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
});

test('default-valued user-agent set by mutating stream options is not overwritten by piped header', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		const gotStream = got.stream('', {copyPipedHeaders: true});
		gotStream.options.headers['user-agent'] = 'got (https://github.com/sindresorhus/got)';

		await streamPipeline(
			request,
			gotStream,
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'user-agent': 'piped-user-agent',
		},
	}).json();
	assert.strictEqual(headers['user-agent'], 'got (https://github.com/sindresorhus/got)');
});

test('default user-agent is overwritten by piped user-agent when copyPipedHeaders is true', withServer, async (_t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream('', {copyPipedHeaders: true}),
			response,
		);
	});

	const headers: Record<string, string> = await got('proxy', {
		headers: {
			'user-agent': 'custom-user-agent',
		},
	}).json();
	assert.strictEqual(headers['user-agent'], 'custom-user-agent');
});

test('skips proxying headers after server has sent them already', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		response.writeHead(200);

		await streamPipeline(
			got.stream(''),
			response,
		);
	});

	const {headers} = await got('proxy');
	assert.strictEqual(headers.unicorn, undefined);
});

test('proxies `content-encoding` header when `options.decompress` is false', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		await streamPipeline(
			got.stream({decompress: false}),
			response,
		);
	});

	const {headers} = await got('proxy', {decompress: false});
	assert.strictEqual(headers.unicorn, 'rainbow');
	assert.strictEqual(headers['content-encoding'], 'gzip');
});

{
	test('destroying got.stream() destroys the request - `request` event', withServer, async (_t, server, got) => {
		server.get('/', defaultHandler);

		const stream = got.stream('');
		const request = await onceValue<ClientRequest>(stream, 'request');
		stream.destroy();
		assert.ok(request.destroyed);
	});

	test('destroying got.stream() destroys the request - `response` event', withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.write('hello');
		});

		const stream = got.stream('');
		const request = await onceValue<ClientRequest>(stream, 'request');
		await once(stream, 'response');
		stream.destroy();
		assert.ok(request.destroyed);
	});
}

test('piping to got.stream.put()', withServer, async (_t, server, got) => {
	server.get('/', defaultHandler);
	server.put('/post', postHandler);

	await assert.doesNotReject(async () => {
		const stream = got.stream.put('post');

		await streamPipeline(
			got.stream(''),
			stream,
		);

		await getStream(stream);
	});
});

// See https://github.com/nodejs/node/issues/35237

test.skip('no unhandled body stream errors', async _t => {
	const body = new FormData();
	body.set('upload', new File([fs.readFileSync('/bin/sh')], 'sh'));

	await assert.rejects(got.post(`https://offlinesite${Date.now()}.com`, {
		body,
	}), {
		code: 'ENOTFOUND',
	});
});

test('works with pipeline', async _t => {
	const error = await rejects(streamPipeline(
		new ReadableStream({
			read() {
				this.push(null);
			},
		}),
		got.stream.put('http://localhost:7777'),
	), RequestError);

	assert.strictEqual(typeof error?.code, 'string');
});

test('errors have body', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'foo=bar');
		response.end('yay');
	});

	const error = await rejects(getStream(got.stream('', {
		strictContentLength: false,
		cookieJar: {
			async setCookie() {
				throw new Error('snap');
			},
			getCookieString: async () => '',
		},
	})));

	assert.strictEqual(error?.message, 'snap');
	assert.strictEqual(error?.response?.body, 'yay');
});

test('pipe can send modified headers', withServer, async (_t, server, got) => {
	server.get('/foobar', (_request, response) => {
		response.setHeader('foo', 'bar');
		response.end();
	});

	server.get('/', (_request, response) => {
		got.stream('foobar').on('response', response => {
			response.headers.foo = 'boo';
		}).pipe(response);
	});

	const {headers} = await got('');
	assert.strictEqual(headers.foo, 'boo');
});

test('the socket is alive on a successful pipeline', withServer, async (_t, server, got) => {
	const payload = 'ok';

	server.get('/', (_request, response) => {
		response.end(payload);
	});

	const gotStream = got.stream('');

	// The assertion runs against a local, because `assert.strictEqual` carries an assertion
	// signature that would narrow the getter to `undefined` for the rest of the block and leave
	// the later read below typed as `never`.
	const socketBeforeRequest = gotStream.socket;
	assert.strictEqual(socketBeforeRequest, undefined);

	const receiver = new stream.PassThrough();
	await streamPipeline(gotStream, receiver);

	assert.strictEqual(await getStream(receiver), payload);
	// Read through a fresh local: the earlier `strictEqual` narrowed the getter, so a direct read
	// of the property is typed `never` here.
	const {socket} = gotStream;
	assert.ok(socket);
	assert.strictEqual(socket.destroyed, false);
});

test('async iterator works', withServer, async (_t, server, got) => {
	const payload = 'ok';

	server.get('/', (_request, response) => {
		response.end(payload);
	});

	const gotStream = got.stream('');
	const chunks = await Array.fromAsync(gotStream);

	assert.strictEqual(Buffer.concat(chunks).toString(), payload);
});

test('destroys only once', async _t => {
	const stream = got.stream('https://example.com');
	stream.destroy();
	stream.destroy(new Error('oh no'));

	let errored = false;

	stream.once('error', () => {
		errored = true;
	});

	await delay(1);

	assert.strictEqual(errored, false);
});

test('does not accept unreadable stream as body', withServer, async (_t, server, got) => {
	server.post('/', (_request, _response) => {});

	const body = new ReadableStream();
	body.push(null);
	body.resume();

	await once(body, 'end');

	const request = got.post({body});

	await assert.rejects(request, RequestError);
});

test('accepts readable-stream as body', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const body = new Readable2({
		read() {
			this.push('ok');
			this.push(null);
		},
	});

	const response = await got.post({
		// We need to cast body as any,
		// because @types/readable-stream has incorrect types
		// and causes a lot of errors.
		body: body as any,
	});

	assert.strictEqual(response.body, 'ok');
});

test('prevents `Cannot call end` error', async _t => {
	const stream = got.stream('https://example.com', {
		// Model a native request's stable capability while keeping its final callback pending.
		request: () => Object.assign(new Writable({
			final() {},
		}), {setHeader() {}}) as any,
		timeout: {
			request: 1,
		},
	});

	const error = await onceValue<RequestError>(stream, 'error');
	assert.strictEqual(error.code, 'ETIMEDOUT');
});

if (Number.parseInt(process.versions.node.split('.', 1)[0]!, 10) <= 12) {
	test('does not emit end event on error', withServer, async (_t, server, got) => {
		server.get('/', infiniteHandler);

		await assert.doesNotReject(new Promise((resolve, reject) => {
			got.stream({
				timeout: {
					request: 100,
				},
				hooks: {
					beforeError: [
						async error => {
							await new Promise(resolve => {
								setTimeout(resolve, 50);
							});

							return error;
						},
					],
				},
			}).once('end', () => {
				reject(new Error('Stream has ended before erroring'));
			}).once('error', resolve).resume();
		}));
	});
}

// Test only on Linux
const testFunction = process.platform === 'linux' ? test : test.skip;
testFunction('it sends a body of file with size on stat = 0', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});

	const response = await got.post({
		body: fs.createReadStream('/proc/cpuinfo'),
	});

	assert.ok(response.body);
});

test('OPTIONS stream without body completes successfully', withServer, async (_t, server, got) => {
	server.options('/', (_request, response) => {
		response.writeHead(200, {
			allow: 'OPTIONS, GET, HEAD, POST',
		});
		response.end();
	});

	const stream = got.stream({method: 'OPTIONS'});
	stream.end();
	await assert.doesNotReject(getStream(stream));
});

test('DELETE stream without body completes successfully', withServer, async (_t, server, got) => {
	server.delete('/', (_request, response) => {
		response.writeHead(204);
		response.end();
	});

	const stream = got.stream({method: 'DELETE'});
	stream.end();
	await assert.doesNotReject(getStream(stream));
});

test('PATCH stream without body completes successfully', withServer, async (_t, server, got) => {
	server.patch('/', (_request, response) => {
		response.writeHead(200);
		response.end('patched');
	});

	const stream = got.stream({method: 'PATCH'});
	stream.end();
	const data = await getStream(stream);
	assert.strictEqual(data, 'patched');
});

test('PATCH stream waits for piped body', withServer, async (_t, server, got) => {
	server.patch('/', postHandler);

	const destination = new stream.PassThrough();
	const responsePromise = getStream(destination);

	await streamPipeline(
		ReadableStream.from(['Hello, world!']),
		got.stream.patch(''),
		destination,
	);

	assert.strictEqual(await responsePromise, 'Hello, world!');
});

test('QUERY stream without body completes successfully', withServer, async (_t, server, got) => {
	server.all('/', (request, response) => {
		assert.strictEqual(request.method, 'QUERY');
		response.writeHead(200);
		response.end('queried');
	});

	const stream = got.stream.query('');
	stream.end();
	const data = await getStream(stream);
	assert.strictEqual(data, 'queried');
});

test('QUERY stream waits for piped body', withServer, async (_t, server, got) => {
	server.all('/', async (request, response) => {
		assert.strictEqual(request.method, 'QUERY');
		await streamPipeline(request, response);
	});

	const destination = new stream.PassThrough();
	const responsePromise = getStream(destination);

	await streamPipeline(
		ReadableStream.from(['query body']),
		got.stream.query(''),
		destination,
	);

	assert.strictEqual(await responsePromise, 'query body');
});

test('throws error when content-length does not match bytes transferred - stream', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': '100',
		});
		response.write('ok'); // Only 2 bytes
		response.end();
	});

	await assert.rejects(
		getStream(got.stream('', {strictContentLength: true})),
		errorMatching(RequestError, {message: /Content-Length mismatch/v}),
	);
});

test('throws error when content-length does not match bytes transferred - promise', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': '100',
		});
		response.write('ok');
		response.end();
	});

	await assert.rejects(
		got('', {strictContentLength: true}),
		errorMatching(RequestError, {message: /Content-Length mismatch/v}),
	);
});

test('does not throw when content-length matches bytes transferred', withServer, async (_t, server, got) => {
	const payload = 'hello world';
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': String(Buffer.byteLength(payload)),
		});
		response.end(payload);
	});

	const body = await got('', {strictContentLength: true}).text();
	assert.strictEqual(body, payload);
});

test('does not throw when content-length header is absent', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200);
		response.end('hello');
	});

	const body = await got('', {strictContentLength: true}).text();
	assert.strictEqual(body, 'hello');
});

test('throws content-length mismatch error by default', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': '100',
		});
		response.write('ok'); // Only 2 bytes
		response.end();
	});

	await assert.rejects(
		got('').text(),
		errorMatching(RequestError, {message: /Content-Length mismatch/v}),
	);
});

test('validates content-length for gzip compressed responses', withServer, async (_t, server, got) => {
	// Gzipped 'ok' - H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA== base64 encoded
	const gzippedData = Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64');
	const incorrectLength = gzippedData.length + 10; // Intentionally wrong

	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-encoding': 'gzip',
			'content-length': String(incorrectLength),
		});
		response.end(gzippedData);
	});

	await assert.rejects(
		got('', {strictContentLength: true}).text(),
		errorMatching(RequestError, {message: /Content-Length mismatch/v}),
	);
});

test('accepts a matching content-length for a gzip compressed response', withServer, async (_t, server, got) => {
	const expectedBody = 'compressed response body'.repeat(100);
	const gzippedData = gzipSync(expectedBody);

	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-encoding': 'gzip',
			'content-length': String(gzippedData.length),
		});

		for (let index = 0; index < gzippedData.length; index += 7) {
			response.write(gzippedData.subarray(index, index + 7));
		}

		response.end();
	});

	const body = await got('', {strictContentLength: true}).text();
	assert.strictEqual(body, expectedBody);
});

test('handles empty gzip compressed responses with strictContentLength', withServer, async (_t, server, got) => {
	// Empty gzip (10 byte header + 8 byte footer, no data)
	const emptyGzippedData = Buffer.from('H4sIAAAAAAAAAwMAAAAAAAAAAAA=', 'base64');

	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-encoding': 'gzip',
			'content-length': String(emptyGzippedData.length),
		});
		response.end(emptyGzippedData);
	});

	const body = await got('', {strictContentLength: true}).text();
	assert.strictEqual(body, '');
});

test('isReadonly is false for streams without body', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post('');
	assert.strictEqual(stream.isReadonly, false);

	stream.end('data');
	await getStream(stream);
});

test('isReadonly is true when body option is provided', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({body: 'test data'});
	assert.strictEqual(stream.isReadonly, true);

	await assert.doesNotReject(getStream(stream));
});

test('cancels a Web ReadableStream body when writing a chunk fails', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	let cancelled = false;
	const body = new globalThis.ReadableStream({
		start(controller) {
			controller.enqueue(1);
		},
		cancel() {
			cancelled = true;
		},
	});

	await assert.rejects(got.post('', {
		body,
		retry: {
			limit: 0,
		},
	}), RequestError);

	assert.strictEqual(cancelled, true);
	assert.strictEqual(body.locked, false);
});

test('isReadonly is true when json option is provided', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({json: {foo: 'bar'}});
	assert.strictEqual(stream.isReadonly, true);

	await assert.doesNotReject(getStream(stream));
});

test('isReadonly is true when form option is provided', withServer, async (_t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({form: {foo: 'bar'}});
	assert.strictEqual(stream.isReadonly, true);

	await assert.doesNotReject(getStream(stream));
});

test('pipe does not copy hop-by-hop headers to a ServerResponse', withServer, async (_t, server, got) => {
	server.get('/upstream', (_request, response) => {
		response.writeHead(200, {
			connection: 'close, x-listed',
			'keep-alive': 'timeout=99',
			'proxy-authenticate': 'Basic',
			te: 'trailers',
			upgrade: 'h2c',
			'x-listed': 'listed',
			'x-custom': 'custom',
		});
		response.end('ok');
	});

	server.get('/', (_request, response) => {
		got.stream('upstream').pipe(response);
	});

	const {headers} = await got('');
	assert.strictEqual(headers['x-custom'], 'custom');
	assert.strictEqual(headers['x-listed'], undefined);
	assert.notStrictEqual(headers['keep-alive'], 'timeout=99');
	assert.strictEqual(headers['proxy-authenticate'], undefined);
	assert.strictEqual(headers.te, undefined);
	assert.strictEqual(headers.upgrade, undefined);
	assert.strictEqual(headers.connection, 'keep-alive');
});

test('destroying the request cancels a Web ReadableStream body', withServer, async (_t, server, got) => {
	server.post('/', () => {});

	let cancelled = false;
	const body = new globalThis.ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('hello world '.repeat(10_000)));
		},
		cancel() {
			cancelled = true;
		},
	});

	const stream = got.stream.post('', {body});
	stream.on('error', () => {});

	while (!body.locked) {
		// eslint-disable-next-line no-await-in-loop
		await delay(5);
	}

	stream.destroy();
	await once(stream, 'close');

	assert.strictEqual(cancelled, true);
	assert.strictEqual(body.locked, false);
});

test('unpipe without a destination stops forwarding response metadata', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 201;
		response.setHeader('x-upstream', 'yes');
		response.end('upstream');
	});

	const destination = new ServerResponse(new IncomingMessage(new Socket()));
	const request = got.stream('');
	t.after(() => request.destroy());
	request.pipe(destination);
	request.unpipe();
	await once(request, 'response');

	assert.strictEqual(destination.statusCode, 200);
	assert.strictEqual(destination.getHeader('x-upstream'), undefined);
});

test('unpipe only stops forwarding metadata to the selected destination', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 201;
		response.setHeader('x-upstream', 'yes');
		response.end('upstream');
	});

	const removed = new ServerResponse(new IncomingMessage(new Socket()));
	const retained = new ServerResponse(new IncomingMessage(new Socket()));
	const request = got.stream('');
	t.after(() => request.destroy());
	request.pipe(removed);
	request.pipe(retained);
	assert.strictEqual(request.unpipe(removed), request);
	request.unpipe(new Writable());
	await once(request, 'response');

	assert.strictEqual(removed.statusCode, 200);
	assert.strictEqual(removed.getHeader('x-upstream'), undefined);
	assert.strictEqual(retained.statusCode, 201);
	assert.strictEqual(retained.getHeader('x-upstream'), 'yes');
});

test('unpipe all destinations allows piping a new destination', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 201;
		response.setHeader('x-upstream', 'yes');
		response.end('upstream');
	});

	const removed = [
		new ServerResponse(new IncomingMessage(new Socket())),
		new ServerResponse(new IncomingMessage(new Socket())),
	];
	const retained = new ServerResponse(new IncomingMessage(new Socket()));
	const request = got.stream('');
	t.after(() => request.destroy());
	for (const destination of removed) {
		request.pipe(destination);
	}

	assert.strictEqual(request.unpipe(), request);
	request.unpipe();
	request.pipe(retained);
	await once(request, 'response');

	for (const destination of removed) {
		assert.strictEqual(destination.statusCode, 200);
		assert.strictEqual(destination.getHeader('x-upstream'), undefined);
	}

	assert.strictEqual(retained.statusCode, 201);
	assert.strictEqual(retained.getHeader('x-upstream'), 'yes');
});

test('an unpiped stream can be resumed and consumed as text', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('complete response');
	});

	// The budget is only a safety net, so keep it well clear of a slow machine.
	const request = got.stream('', {timeout: {request: 10_000}, retry: {limit: 0}});
	const destination = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	request.pipe(destination);
	request.unpipe();

	const response = getStream(request);
	request.resume();
	assert.strictEqual(await response, 'complete response');
});

test('isAborted reflects cancellation through an AbortSignal', withServer, async (_t, _server, got) => {
	const controller = new AbortController();
	const request = got.stream('', {signal: controller.signal});
	const body = getStream(request);
	controller.abort();
	await assert.rejects(body, {code: 'ERR_ABORTED'});

	assert.strictEqual(request.isAborted, true);
});

test('isAborted is true for a signal cancelled before creating the stream', withServer, async (_t, _server, got) => {
	const request = got.stream('', {signal: AbortSignal.abort()});

	await assert.rejects(getStream(request), {code: 'ERR_ABORTED'});
	assert.strictEqual(request.isAborted, true);
});

test('isAborted is set before cancellation emits an error on an active request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.write('partial');
	});

	const controller = new AbortController();
	const request = got.stream('', {signal: controller.signal});
	const response = once(request, 'response');
	const body = getStream(request);
	const rejection = rejects(body, {code: 'ERR_ABORTED'});
	await response;

	controller.abort();
	assert.strictEqual(request.isAborted, true);
	await rejection;
});

test('isAborted is true when the signal carries a timeout reason', withServer, async (_t, _server, got) => {
	const reason = new DOMException('Request deadline expired', 'TimeoutError');
	const request = got.stream('', {signal: AbortSignal.abort(reason)});

	await assert.rejects(getStream(request), {name: 'TimeoutError'});
	assert.strictEqual(request.isAborted, true);
});

test('completed streams do not become aborted when their former signal is cancelled', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('complete');
	});

	const controller = new AbortController();
	const request = got.stream('', {signal: controller.signal});
	assert.strictEqual(await getStream(request), 'complete');
	assert.strictEqual(request.isAborted, false);

	controller.abort();
	assert.strictEqual(request.isAborted, false);
});

test('UTF-8 decoded responses retain byte-accurate download accounting', withServer, async (_t, server, got) => {
	const body = '€🙂';
	server.get('/', (_request, response) => {
		response.setHeader('content-length', Buffer.byteLength(body));
		response.end(body);
	});
	const request = got.stream('', {strictContentLength: true});
	request.on('response', response => {
		response.setEncoding('utf8');
	});

	assert.strictEqual(await getStream(request), body);
	assert.deepStrictEqual(request.downloadProgress, {percent: 1, transferred: 7, total: 7});
});

test('decoded response progress counts UTF-8 bytes across split characters', withServer, async (_t, server, got) => {
	const body = 'é🙂漢';
	const bytes = Buffer.from(body);
	server.get('/', async (_request, response) => {
		response.setHeader('content-length', bytes.length);
		response.write(bytes.subarray(0, 4));
		await delay(5);
		response.end(bytes.subarray(4));
	});
	const request = got.stream('');
	const transferred: number[] = [];
	request.on('response', response => {
		response.setEncoding('utf8');
	});
	request.on('downloadProgress', progress => {
		transferred.push(progress.transferred);
	});

	assert.strictEqual(await getStream(request), body);
	assert.strictEqual(request.downloadProgress.total, 9);
	assert.strictEqual(request.downloadProgress.transferred, 9);
	assert.strictEqual(transferred.at(-1), 9);
	assert.strictEqual(transferred.every(value => value >= 0 && value <= 9), true);
});

test('decoded truncated responses still report the actual UTF-8 byte count', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.shouldKeepAlive = false;
		response.setHeader('content-length', 7);
		response.end('€');
	});
	const request = got.stream('', {strictContentLength: true, retry: {limit: 0}});
	request.on('response', response => {
		response.setEncoding('utf8');
	});

	await assert.rejects(getStream(request), {
		code: 'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
		message: 'Content-Length mismatch: expected 7 bytes, received 3 bytes',
	});
	assert.strictEqual(request.downloadProgress.transferred, 3);
});

test('custom native response decoding preserves promise body bytes and progress', withServer, async (_t, server, got) => {
	const body = '€🙂';
	server.get('/', (_request, response) => {
		response.setHeader('content-length', Buffer.byteLength(body));
		response.end(body);
	});
	const response = await got('', {
		strictContentLength: true,
		request(url, options) {
			const request = httpRequest(url, options);
			request.once('response', response => {
				response.setEncoding('utf8');
			});
			return request;
		},
	});

	assert.strictEqual(response.body, body);
	assert.deepStrictEqual(response.rawBody, new Uint8Array(Buffer.from(body)));
	assert.deepStrictEqual(response.request.downloadProgress, {percent: 1, transferred: 7, total: 7});
});

const createBufferedResponse = () => {
	let produced = 0;
	const response = new IncomingMessage(new Socket());
	response.statusCode = 200;
	response.headers = {};
	response._read = function () {
		if (produced === 100) {
			this.complete = true;
			this.push(null);
			return;
		}

		produced++;
		this.push(Buffer.alloc(1024, 'a'));
	};

	return {
		response, get produced() {
			return produced;
		},
	};
};

test('a custom response is closed when aborted before manual upload completion', withServer, async (t, _server, got) => {
	const response = new IncomingMessage(new Socket());
	response.statusCode = 200;
	t.after(() => {
		response.destroy();
	});

	const created = Promise.withResolvers<void>();
	const controller = new AbortController();
	const request = got.stream.post('', {
		signal: controller.signal,
		request() {
			created.resolve();
			return response;
		},
	});
	request.on('error', () => {});
	const closed = new Promise<void>(resolve => {
		request.once('close', resolve);
	});
	await created.promise;
	assert.strictEqual(request.writableEnded, false);
	controller.abort();
	await closed;

	assert.strictEqual(request.destroyed, true);
	assert.strictEqual(response.destroyed, true);
});

test('custom response streams stop producing when the consumer applies backpressure', withServer, async (t, _server, got) => {
	const source = createBufferedResponse();
	const request = got.stream('', {hooks: {beforeRequest: [() => source.response]}});
	t.after(() => {
		request.destroy();
		source.response.destroy();
	});
	await once(request, 'readable');

	assert.strictEqual(source.produced < 100, true);
	assert.strictEqual(request.readableLength < 100 * 1024, true);
	const producedBeforePause = source.produced;
	await delay(10);
	assert.strictEqual(source.produced, producedBeforePause);
	assert.strictEqual(await getStream(request), 'a'.repeat(100 * 1024));
	assert.strictEqual(source.produced, 100);
	assert.strictEqual(request.readableEnded, true);
});

test('custom response streams honor a slow writable destination', withServer, async (t, _server, got) => {
	const source = createBufferedResponse();
	const request = got.stream('', {hooks: {beforeRequest: [() => source.response]}});
	let releaseFirstWrite: () => void = () => {};
	let notifyFirstWrite: () => void = () => {};
	const firstWrite = new Promise<void>(resolve => {
		notifyFirstWrite = resolve;
	});
	let received = 0;
	const destination = new Writable({
		highWaterMark: 1,
		write(chunk: Uint8Array, _encoding, callback) {
			const isFirstWrite = received === 0;
			received += chunk.length;
			if (isFirstWrite) {
				releaseFirstWrite = callback;
				notifyFirstWrite();
				return;
			}

			callback();
		},
	});
	t.after(() => {
		releaseFirstWrite();
		request.destroy();
		destination.destroy();
		source.response.destroy();
	});
	const finished = once(destination, 'finish');
	request.pipe(destination);
	await firstWrite;

	assert.strictEqual(source.produced < 100, true);
	assert.strictEqual(received < 100 * 1024, true);
	releaseFirstWrite();
	releaseFirstWrite = () => {};
	await finished;
	assert.strictEqual(received, 100 * 1024);
	assert.strictEqual(source.produced, 100);
});

test('a response destroyed while the consumer is paused becomes a ReadError and stops the source', withServer, async (t, _server, got) => {
	const source = createBufferedResponse();
	const request = got.stream('', {retry: {limit: 0}, hooks: {beforeRequest: [() => source.response]}});
	t.after(() => {
		request.destroy();
		source.response.destroy();
	});
	await once(request, 'readable');
	const producedBeforeError = source.produced;
	const errorPromise = once(request, 'error');
	const expectedError = new Error('response failed while paused');
	source.response.destroy(expectedError);

	const [error] = await errorPromise as unknown as [RequestError];
	// IncomingMessage.destroy() reports an aborted response before emitting its supplied error.
	assert.strictEqual(error.name, 'ReadError');
	assert.strictEqual(error.code, 'ECONNRESET');
	assert.strictEqual(source.produced, producedBeforeError);
	assert.strictEqual(request.destroyed, true);
});

test('Latin1 decoded responses retain their original byte count', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-length', 1);
		response.end(Buffer.from([0xFF]));
	});
	const request = got.stream('', {strictContentLength: true});
	request.on('response', response => {
		response.setEncoding('latin1');
	});

	assert.strictEqual(await getStream(request), 'ÿ');
	assert.deepStrictEqual(request.downloadProgress, {percent: 1, transferred: 1, total: 1});
});

for (const {encoding, body, expectedText} of [
	{encoding: 'utf16le', body: Buffer.from('€🙂', 'utf16le'), expectedText: '€🙂'},
	{encoding: 'base64', body: Buffer.from([0xFF, 0, 1, 2]), expectedText: '/wABAg=='},
	{encoding: 'hex', body: Buffer.from([0, 0xFF]), expectedText: '00ff'},
] as const) {
	test(`${encoding} decoded responses retain their original byte count`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('content-length', body.length);
			response.end(body);
		});
		const request = got.stream('', {strictContentLength: true});
		request.on('response', response => {
			response.setEncoding(encoding);
		});

		assert.strictEqual(await getStream(request), expectedText);
		assert.deepStrictEqual(request.downloadProgress, {percent: 1, transferred: body.length, total: body.length});
	});
}

// Got copies the status code and headers into a piped `ServerResponse`, so it owns it. A
// request that ends without a body must not leave the client waiting forever.
for (const [name, upstreamStatus] of [
	['a non-2xx response', 503],
	['a 404 response', 404],
] as Array<[string, number]>) {
	test(`closes a piped ServerResponse when the upstream request fails: ${name}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = upstreamStatus;
			response.end('upstream body');
		});

		server.get('/proxy', (_request, response) => {
			const stream = got.stream('', {retry: {limit: 0}});
			stream.on('error', () => {});
			stream.pipe(response);
		});

		const error = await rejects(got('proxy'));
		assert.strictEqual(error.code, 'ECONNRESET');
	});
}

// An `error` listener runs before Got closes the destination, so a proxy can still answer the
// client itself, whether the upstream failed before or after a response arrived.
for (const [name, upstreamPath] of [
	['before a response', 'refused'],
	['after a response', 'unavailable'],
] as Array<[string, string]>) {
	test(`an error listener can still answer a piped ServerResponse: ${name}`, withServer, async (_t, server, got) => {
		server.get('/unavailable', (_request, response) => {
			response.statusCode = 503;
			response.end('upstream body');
		});

		server.get('/proxy', (_request, response) => {
			// Port 1 is never listening, so the connection is refused before any response.
			const url = upstreamPath === 'refused' ? 'http://127.0.0.1:1/' : `${server.url}/unavailable`;
			const stream = got.stream(url, {prefixUrl: '', retry: {limit: 0}});
			stream.pipe(response);
			stream.on('error', () => {
				response.statusCode = 502;
				response.end('Upstream failed');
			});
		});

		const response = await got('proxy', {throwHttpErrors: false, retry: {limit: 0}});
		assert.strictEqual(response.statusCode, 502);
		assert.strictEqual(response.body, 'Upstream failed');
	});
}

test('keeps a piped ServerResponse open on a successful request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('proxied body');
	});
	server.get('/proxy', (_request, response) => {
		got.stream().pipe(response);
	});

	const response = await got('proxy');

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.body, 'proxied body');
});

// A signal shared by several requests must not reach one that has already finished, or the
// stream is destroyed long after its body was consumed.
test('a completed stream is not destroyed by a shared signal firing later', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('complete body');
	});

	const abortController = new AbortController();
	const stream = got.stream('', {signal: abortController.signal});
	const errors: Error[] = [];
	stream.on('error', error => {
		errors.push(error);
	});

	// Read to the end without destroying the stream, which `getStream()` would do.
	const body = await new Promise<string>((resolve, reject) => {
		let text = '';
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			text += chunk;
		});
		stream.on('end', () => {
			resolve(text);
		});
		stream.on('error', reject);
	});
	assert.strictEqual(body, 'complete body');
	assert.strictEqual(stream.destroyed, false);

	abortController.abort();
	await delay(50);

	assert.deepStrictEqual(errors, []);
	assert.strictEqual(stream.destroyed, false);
	assert.strictEqual(stream.isAborted, false);
});

for (const abortBeforeFinish of [false, true]) {
	test(`a signal firing after response EOF ${abortBeforeFinish ? 'still aborts a pending upload' : 'does not abort after upload completion'}`, {timeout: 3000}, withServer, async (_t, server, got) => {
		server.post('/', async (request, response) => {
			await request.toArray();
			response.end('complete body');
		});

		const controller = new AbortController();
		const endCallback = Promise.withResolvers<() => void>();
		const request = got.stream.post('', {
			body: 'payload',
			signal: controller.signal,
			request(url, options) {
				const request = httpRequest(url, options);
				const end = request.end.bind(request);
				request.end = ((callback: () => void) => end(() => {
					endCallback.resolve(callback);
				})) as typeof request.end;
				return request;
			},
		});
		const errors: Error[] = [];
		request.on('error', error => {
			errors.push(error);
		});
		if (!abortBeforeFinish) {
			request.once('finish', () => {
				controller.abort();
			});
		}

		const responseEnded = once(request, 'end');
		request.resume();
		const releaseEnd = await endCallback.promise;
		await responseEnded;
		assert.strictEqual(request.writableFinished, false);

		if (abortBeforeFinish) {
			const closed = new Promise<void>(resolve => {
				request.once('close', resolve);
			});
			controller.abort();
			releaseEnd();
			await closed;

			assert.strictEqual(errors.length, 1);
			assert.strictEqual((errors[0] as RequestError).code, 'ERR_ABORTED');
			assert.strictEqual(request.destroyed, true);
			assert.strictEqual(request.isAborted, true);
			return;
		}

		const finished = once(request, 'finish');
		releaseEnd();
		await finished;
		await delay(0);

		assert.deepStrictEqual(errors, []);
		assert.strictEqual(request.destroyed, false);
		assert.strictEqual(request.isAborted, false);
	});
}

// A retry only replaces the request, so a piped `ServerResponse` must survive it.
test('a piped ServerResponse survives a retry', withServer, async (_t, server, got) => {
	let attempts = 0;
	server.get('/', (_request, response) => {
		attempts++;
		if (attempts === 1) {
			response.statusCode = 503;
			response.end('try again');
			return;
		}

		response.end('recovered body');
	});
	server.get('/proxy', (_request, response) => {
		const stream = got.stream('', {
			retry: {
				limit: 1,
				statusCodes: [503],
			},
		});

		stream.once('retry', (_retryCount, _error, createRetryStream) => {
			createRetryStream().pipe(response);
		});
		stream.pipe(response);
	});

	const {body} = await got('proxy');

	assert.strictEqual(body, 'recovered body');
	assert.strictEqual(attempts, 2);
});

// The request is already destroyed by the time a `retry` listener runs, so a listener that
// throws leaves no next attempt to hand the piped response to.
test('a piped ServerResponse is closed when a retry listener throws', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('fail');
	});
	server.get('/proxy', (_request, response) => {
		const stream = got.stream('', {
			retry: {
				limit: 1,
				calculateDelay: () => 1,
			},
		});

		stream.on('error', () => {});
		stream.on('retry', () => {
			throw new Error('listener boom');
		});
		stream.pipe(response);
	});

	// The proxy client is released instead of waiting for a body that never arrives.
	const error = await rejects(got('proxy'));
	assert.strictEqual(error.code, 'ECONNRESET');
});

// The HTTP/2 compatibility layer hands out `Http2ServerResponse`, which Got owns just like an
// HTTP/1 `ServerResponse` once it pipes into it: a failed upstream must not leave the client
// waiting forever.
test('closes a piped HTTP/2 ServerResponse when the upstream request fails', async t => {
	const upstream = http.createServer((_request, response) => {
		response.writeHead(200, {'content-length': 100});
		response.write('abc');
		setTimeout(() => {
			response.destroy();
		}, 20);
	});
	await new Promise<void>(resolve => {
		upstream.listen(0, '127.0.0.1', resolve);
	});
	const {port: upstreamPort} = upstream.address() as net.AddressInfo;
	t.after(async () => {
		await new Promise<void>(resolve => {
			upstream.close(() => {
				resolve();
			});
		});
	});

	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		rejectUnauthorized: false,
	}, (_request, response) => {
		const stream = got.stream(`http://127.0.0.1:${upstreamPort}/`, {retry: {limit: 0}});
		stream.pipe(response);
		stream.on('error', () => {});
	});
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const {port} = server.address() as net.AddressInfo;

	// Cleanups run in registration order, and the server only closes once the session is gone.
	const session = http2.connect(`https://127.0.0.1:${port}`, {rejectUnauthorized: false});
	t.after(() => {
		session.destroy();
	});
	t.after(async () => {
		await new Promise<void>(resolve => {
			server.close(() => {
				resolve();
			});
		});
	});

	const request = session.request({':path': '/'});
	const settled = new Promise<string>(resolve => {
		request.on('data', () => {});
		request.on('close', () => {
			resolve('closed');
		});
		request.on('error', (error: Error) => {
			resolve(error.message);
		});
	});

	const timeout = delay(2000).then(() => 'hang');
	const outcome = await Promise.race([settled, timeout]);
	// A clean close would tell the client the truncated body was complete.
	assert.match(outcome, /NGHTTP2_INTERNAL_ERROR/v);
});

// A stream with a `body`, `json` or `form` option is read-only: Got dispatches that payload
// itself, and a user write would land past the framed `content-length` and corrupt the request.
test('writing to a read-only stream fails instead of corrupting the request', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.on('end', () => {
			response.end('ok');
		});
	});

	const stream = got.stream.post('', {json: {a: 1}});
	const error = await new Promise<Error>(resolve => {
		stream.once('error', resolve);
		stream.write('extra');
	});

	assert.match(error.message, /read-only/v);
});

test('a read-only stream rejects writes buffered behind cork', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.on('end', () => {
			response.end('ok');
		});
	});

	const stream = got.stream.post('', {json: {a: 1}});
	const error = await new Promise<Error>(resolve => {
		stream.once('error', resolve);
		stream.cork();
		stream.write('buffered');
		stream.uncork();
	});

	assert.match(error.message, /read-only/v);
});

test('a refused write to a read-only stream still calls its callback', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.on('end', () => {
			response.end('ok');
		});
	});

	const stream = got.stream.post('', {json: {a: 1}});
	stream.on('error', () => {});
	const error = await new Promise<Error | undefined>(resolve => {
		stream.write('extra', error => {
			resolve(error ?? undefined);
		});
	});

	assert.match(error?.message ?? '', /read-only/v);
});

for (const nodeStream of [false, true]) {
	test(`a read-only ${nodeStream ? 'Node stream' : 'iterable'} body rejects user writes after dispatch starts`, withServer, async (_t, server, got) => {
		server.post('/', async (request, response) => {
			response.end(await getStream(request));
		});
		const callback = Promise.withResolvers<Error | undefined>();
		const body = nodeStream ? ReadableStream.from(['intended']) : ['intended'];
		const request = got.stream.post('', {body});
		request.once('request', () => {
			request.write('injected', error => {
				callback.resolve(error ?? undefined);
			});
		});

		await assert.rejects(request.toArray(), /read-only/v);
		assert.match((await callback.promise)?.message ?? '', /read-only/v);
	});
}

for (const payload of ['body', 'json', 'form', 'Node stream', 'iterable'] as const) {
	for (const operation of ['write', 'end', 'corked write'] as const) {
		test(`a read-only ${payload} request rejects ${operation} after dispatch`, withServer, async (_t, server, got) => {
			server.post('/', (request, response) => {
				request.resume();
				request.once('end', () => {
					response.end('complete');
				});
			});
			const callback = Promise.withResolvers<Error | undefined>();
			let callbackCalls = 0;
			const request = got.stream.post('', {
				...(payload === 'body' && {body: 'intended'}),
				...(payload === 'json' && {json: {value: 'intended'}}),
				...(payload === 'form' && {form: {value: 'intended'}}),
				...(payload === 'Node stream' && {body: ReadableStream.from(['intended'])}),
				...(payload === 'iterable' && {body: ['intended']}),
			});
			request.once('request', () => {
				const complete = (error?: Error | null) => { // eslint-disable-line @typescript-eslint/no-restricted-types
					callbackCalls++;
					callback.resolve(error ?? undefined);
				};

				if (operation === 'end') {
					request.end('injected', complete);
				} else {
					if (operation === 'corked write') {
						request.cork();
					}

					assert.strictEqual(request.write('injected', complete), false);
					request.uncork();
				}
			});

			await assert.rejects(request.toArray(), /read-only/v);
			assert.match((await callback.promise)?.message ?? '', /read-only/v);
			assert.strictEqual(callbackCalls, 1);
		});
	}
}

test('a body supplied by beforeRequest rejects an earlier buffered public write', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.end('complete');
		});
	});
	const request = got.stream.post('', {
		hooks: {
			beforeRequest: [options => {
				options.body = 'configured';
			}],
		},
	});
	const callback = Promise.withResolvers<Error | undefined>();
	request.write('buffered before the hook', error => {
		callback.resolve(error ?? undefined);
	});

	await assert.rejects(request.toArray(), /read-only/v);
	assert.match((await callback.promise)?.message ?? '', /read-only/v);
});

test('a configured Node body keeps its pipe notification and filtered header metadata', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	const body = Object.assign(ReadableStream.from(['first', 'second']), {
		headers: {
			'x-source': 'copied',
			'x-explicit': 'source',
			cookie: 'secret',
			connection: 'x-hop',
			'x-hop': 'omitted',
		},
	});
	const request = got.stream.post('', {body, copyPipedHeaders: true, headers: {'x-explicit': 'caller'}});
	let pipeEvents = 0;
	request.once('pipe', source => {
		pipeEvents++;
		assert.strictEqual(source, body);
	});

	assert.strictEqual(await getStream(request), 'firstsecond');
	assert.strictEqual(pipeEvents, 1);
	assert.strictEqual(request.options.headers['x-source'], 'copied');
	assert.strictEqual(request.options.headers['x-explicit'], 'caller');
	assert.strictEqual(request.options.headers.cookie, undefined);
	assert.strictEqual(request.options.headers.connection, undefined);
	assert.strictEqual(request.options.headers['x-hop'], undefined);
});

for (const suppliedByHook of [false, true]) {
	test(`a Node body ${suppliedByHook ? 'supplied by a hook' : 'provided initially'} transfers source-error ownership without removing caller listeners`, withServer, async (_t, server, got) => {
		server.post('/', async (request, response) => {
			response.end(await getStream(request));
		});
		let listenersDuringRead = 0;
		const body = new ReadableStream({
			read() {
				listenersDuringRead = this.listenerCount('error');
				this.push('payload');
				this.push(null);
			},
		});
		const callerListener = () => {};
		body.on('error', callerListener);
		let listenersDuringPipe = 0;
		const request = got.stream.post('', {
			...(!suppliedByHook && {body}),
			hooks: suppliedByHook
				? {
					beforeRequest: [options => {
						options.body = body;
					}],
				}
				: undefined,
		}).once('pipe', () => {
			listenersDuringPipe = body.listenerCount('error');
		});

		assert.strictEqual(await getStream(request), 'payload');
		assert.strictEqual(listenersDuringPipe, 2);
		assert.strictEqual(listenersDuringRead, 2);
		assert.strictEqual(body.listeners('error').includes(callerListener), true);
	});
}

test('cancelling from a configured body pipe notification does not start reading it', withServer, async (_t, _server, got) => {
	let reads = 0;
	const body = new ReadableStream({
		read() {
			reads++;
			this.push('unused');
			this.push(null);
		},
	});
	const controller = new AbortController();
	const request = got.stream.post('', {body, signal: controller.signal});
	request.once('pipe', () => {
		controller.abort();
	});

	await assert.rejects(request.toArray(), {code: 'ERR_ABORTED'});
	assert.strictEqual(reads, 0);
	assert.strictEqual(body.destroyed, true);
});

test('a superseded iterable upload stops writing while a redirect hook is pending', withServer, async (t, server, got) => {
	server.post('/start', (request, response) => {
		request.once('data', () => {
			response.writeHead(307, {location: '/target'});
			response.end();
		});
		request.resume();
	});
	server.post('/target', async (request, response) => {
		response.end(await getStream(request));
	});
	const hookStarted = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const releaseSource = Promise.withResolvers<void>();
	const sourceClosed = Promise.withResolvers<void>();
	let initialRequest: ClientRequest | undefined;
	t.after(() => {
		releaseHook.resolve();
		releaseSource.resolve();
		initialRequest?.destroy();
	});
	const request = got.stream.post('start', {
		body: {
			async * [Symbol.asyncIterator]() {
				try {
					yield 'first';
					await releaseSource.promise;
					yield 'must not be uploaded';
				} finally {
					sourceClosed.resolve();
				}
			},
		},
		hooks: {
			beforeRedirect: [async options => {
				options.body = 'replacement';
				hookStarted.resolve();
				await releaseHook.promise;
			}],
		},
	}).once('request', nativeRequest => {
		initialRequest = nativeRequest;
	});
	const response = getStream(request);
	await hookStarted.promise;
	const socket = initialRequest!.socket!;
	const sentBeforeRelease = socket.bytesWritten;
	releaseSource.resolve();
	await sourceClosed.promise;
	const sentAfterRelease = socket.bytesWritten;
	releaseHook.resolve();

	assert.strictEqual(await response, 'replacement');
	assert.strictEqual(sentAfterRelease, sentBeforeRelease);
});

const nonUtf8ErrorBody = Buffer.from([0xFF, 0x00, 0xE9, 0x41]);

const nonUtf8ErrorEndpoint: Handler = (_request, response) => {
	response.statusCode = 500;
	response.end(nonUtf8ErrorBody);
};

test('promise HTTP errors keep non-UTF-8 response bytes in `rawBody`', withServer, async (_t, server, got) => {
	server.get('/', nonUtf8ErrorEndpoint);

	const error = await rejects<HTTPError>(got('', {retry: {limit: 0}}), {name: 'HTTPError'});

	assert.deepStrictEqual(error.response.rawBody, new Uint8Array(nonUtf8ErrorBody));
});

test('stream HTTP errors keep non-UTF-8 response bytes in `rawBody`', withServer, async (_t, server, got) => {
	server.get('/', nonUtf8ErrorEndpoint);

	const error = await rejects<HTTPError>(got.stream('', {retry: {limit: 0}}).toArray(), {name: 'HTTPError'});

	assert.deepStrictEqual(error.response.rawBody, new Uint8Array(nonUtf8ErrorBody));
});

test('stream HTTP errors decode the response body with the `encoding` option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end(Buffer.from('café', 'latin1'));
	});

	const error = await rejects<HTTPError>(got.stream('', {retry: {limit: 0}, encoding: 'latin1'}).toArray(), {name: 'HTTPError'});

	assert.strictEqual(error.response.body, 'café');
});

test('stream HTTP errors keep compressed bytes in `rawBody` when decompression is disabled', withServer, async (_t, server, got) => {
	const compressed = gzipSync('compressed error body');
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.setHeader('content-encoding', 'gzip');
		response.end(compressed);
	});

	const error = await rejects<HTTPError>(got.stream('', {retry: {limit: 0}, decompress: false}).toArray(), {name: 'HTTPError'});

	assert.deepStrictEqual(error.response.rawBody, new Uint8Array(compressed));
});

for (const encoding of ['hex', 'utf8'] as const) {
	test(`stream HTTP errors capture the exact bytes when the stream has the \`${encoding}\` encoding`, withServer, async (_t, server, got) => {
		server.get('/', nonUtf8ErrorEndpoint);

		const stream = got.stream('', {retry: {limit: 0}});
		stream.setEncoding(encoding);

		const error = await rejects<HTTPError>(stream.toArray(), {name: 'HTTPError'});

		assert.deepStrictEqual(error.response.rawBody, new Uint8Array(nonUtf8ErrorBody));
	});
}

test('stream emits `request`, `response`, data, the final `downloadProgress` and `end` in order', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-length', 10);
		response.write('hello');
		setTimeout(() => {
			response.end('world');
		}, 10);
	});

	const events: string[] = [];
	const stream = got.stream('');
	stream.on('request', () => {
		events.push('request');
	});
	stream.on('response', () => {
		events.push('response');
	});
	stream.on('downloadProgress', progress => {
		events.push(`progress:${progress.transferred}/${progress.total}`);
	});
	stream.on('data', () => {
		events.push('data');
	});

	await once(stream, 'end');

	assert.strictEqual(events.indexOf('request') < events.indexOf('response'), true);
	assert.strictEqual(events.indexOf('response') < events.indexOf('data'), true);
	assert.strictEqual(events.at(-1), 'progress:10/10');
	assert.strictEqual(events.lastIndexOf('data') < events.indexOf('progress:10/10'), true);
	assert.strictEqual(events.filter(event => event === 'progress:10/10').length, 1);
});

test('`setEncoding` on a stream applies to the decompressed bytes', withServer, async (_t, server, got) => {
	const payload = Buffer.from('café 🦄');
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end(gzipSync(payload));
	});

	const chunks = await got.stream('').setEncoding('hex').toArray();

	assert.strictEqual(chunks.join(''), payload.toString('hex'));
});

test('stream with decompression disabled emits the compressed bytes and keeps `content-encoding`', withServer, async (_t, server, got) => {
	const compressed = gzipSync('compressed body');
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end(compressed);
	});

	const stream = got.stream('', {decompress: false});
	const responsePromise = once(stream, 'response');
	const chunks = await stream.toArray();
	const [response] = await responsePromise as [PlainResponse];

	assert.deepStrictEqual(Buffer.concat(chunks), compressed);
	assert.strictEqual(response.headers['content-encoding'], 'gzip');
});
