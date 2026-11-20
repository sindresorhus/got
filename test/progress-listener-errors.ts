import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import process from 'node:process';
import {promisify} from 'node:util';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const api of ['promise', 'stream']) {
	for (const direction of ['upload', 'download']) {
		for (const phase of ['middle', 'final']) {
			test(`a throwing ${phase} ${direction} progress listener rejects the ${api} API through error hooks`, withServer, async (_t, server) => {
				server.all('/', (request, response) => {
					request.on('error', () => {});
					if (direction === 'upload') {
						// Do not respond. A response that ends before the final upload callback lets the stream API finish without the final progress event.
						request.resume();
					} else {
						response.end(Buffer.alloc(100_000));
					}
				});
				// Listener failures in native stream callbacks must reject the operation instead of escaping the process.
				const script = `
					import assert from 'node:assert/strict';
					import {Buffer} from 'node:buffer';
					import {setImmediate} from 'node:timers/promises';
					import got, {RequestError} from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
					const api = ${JSON.stringify(api)};
					const direction = ${JSON.stringify(direction)};
					const phase = ${JSON.stringify(phase)};
					const cause = new Error('Progress observer failed');
					const entered = Promise.withResolvers();
					const release = Promise.withResolvers();
					let errorHooks = 0;
					let throws = 0;
					let settled = false;
					const options = {
						retry: {limit: 0},
						timeout: {request: 2000},
						...(direction === 'upload' && {body: Buffer.alloc(100_000)}),
						hooks: {beforeError: [async error => {
							errorHooks++;
							assert.strictEqual(error.cause, cause);
							entered.resolve();
							await release.promise;
							return error;
						}]},
					};
					const method = direction === 'upload' ? 'post' : 'get';
					const request = (api === 'promise' ? got : got.stream)[method](process.argv[1], options);
					request.on(direction + 'Progress', progress => {
						if (phase === 'final' ? progress.percent === 1 : progress.transferred > 0 && progress.percent < 1) {
							throws++;
							throw cause;
						}
					});
					const operation = api === 'promise' ? request : request.toArray();
					const observed = Promise.resolve(operation).then(
						() => {settled = true; return {};},
						error => {settled = true; return {error: error};},
					);
					try {
						await Promise.race([entered.promise, observed]);
						assert.strictEqual(errorHooks, 1);
						await setImmediate();
						assert.strictEqual(settled, false, 'The request must wait for its asynchronous error hook');
					} finally {
						release.resolve();
					}
					const result = await observed;
					assert.ok(result.error instanceof RequestError);
					assert.strictEqual(result.error.cause, cause);
					assert.strictEqual(errorHooks, 1);
					assert.strictEqual(throws, 1);
				`;
				const {stdout, stderr} = await promisify(execFile)(process.execPath, ['--import=tsx/esm', '--input-type=module', '--eval', script, server.url], {timeout: 5000});
				assert.strictEqual(stdout, '');
				assert.strictEqual(stderr, '');
			});
		}
	}
}

for (const phase of ['middle', 'final']) {
	test(`a throwing ${phase} upload progress listener still settles its manual write callback`, {timeout: 5000}, withServer, async (_t, server, got) => {
		server.post('/', request => {
			request.on('error', () => {});
			request.resume();
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const cause = new Error('Manual upload observer failed');
		let callbacks = 0;
		let callbackError: unknown;
		const request = got.stream.post('', {
			retry: {limit: 0},
			hooks: {
				beforeError: [async error => {
					entered.resolve();
					await release.promise;
					return error;
				}],
			},
		});
		request.on('uploadProgress', progress => {
			if (phase === 'final' ? progress.percent === 1 : progress.transferred > 0 && progress.percent < 1) {
				throw cause;
			}
		});
		const rejected = assert.rejects(request.toArray(), error => error instanceof Error && error.cause === cause);
		request[phase === 'final' ? 'end' : 'write'](Buffer.alloc(100_000), (error?: Error) => {
			callbacks++;
			callbackError = error;
			completed.resolve();
		});
		try {
			await Promise.all([entered.promise, completed.promise]);
			assert.strictEqual(callbacks, 1);
			assert.ifError(callbackError);
		} finally {
			release.resolve();
		}

		await rejected;
		assert.strictEqual(callbacks, 1);
	});
}

test('a throwing upload progress listener releases its iterable before an asynchronous error hook finishes', {timeout: 5000}, withServer, async (_t, server, got) => {
	server.post('/', request => {
		request.on('error', () => {});
		request.resume();
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const finalized = Promise.withResolvers<void>();
	const cause = new Error('Iterable upload observer failed');
	let pulls = 0;
	const body = (async function * () {
		try {
			pulls++;
			yield 'first';
			pulls++;
			yield 'second';
		} finally {
			finalized.resolve();
		}
	})();
	const request = got.post('', {
		body,
		retry: {limit: 0},
		hooks: {
			beforeError: [async error => {
				entered.resolve();
				await release.promise;
				return error;
			}],
		},
	});
	void request.on('uploadProgress', progress => {
		if (progress.transferred > 0) {
			throw cause;
		}
	});
	const rejected = assert.rejects(request, error => error instanceof Error && error.cause === cause);
	try {
		await Promise.all([entered.promise, finalized.promise]);
		assert.strictEqual(pulls, 1);
	} finally {
		release.resolve();
	}

	await rejected;
});

for (const direction of ['upload', 'download']) {
	test(`a progress listener failure during ${direction} uses the normal retry path`, withServer, async (_t, server, got) => {
		server.all('/', (request, response) => {
			request.on('error', () => {});
			request.resume();
			request.once('end', () => {
				response.end('x'.repeat(100_000));
			});
		});
		const cause = Object.assign(new Error('Retryable observer failure'), {code: 'ECONNRESET'});
		let failures = 0;
		let retries = 0;
		const request = got('', {
			...(direction === 'upload' && {method: 'POST', body: Buffer.alloc(100_000)}),
			retry: {limit: 1, methods: ['GET', 'POST'], calculateDelay: () => 1},
			hooks: {
				beforeRetry: [error => {
					retries++;
					assert.strictEqual(error.cause, cause);
				}],
			},
		});
		void request.on(direction === 'upload' ? 'uploadProgress' : 'downloadProgress', progress => {
			if (failures === 0 && progress.transferred > 0 && progress.percent < 1) {
				failures++;
				throw cause;
			}
		});
		assert.strictEqual((await request).body, 'x'.repeat(100_000));
		assert.strictEqual(failures, 1);
		assert.strictEqual(retries, 1);
	});
}
