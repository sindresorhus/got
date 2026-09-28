import {Buffer} from 'node:buffer';
import {ReadStream} from 'node:fs';
import {ClientRequest} from 'node:http';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import {type Response, AbortError, HTTPError} from '../source/index.js';
import test from './helpers/test.js';
import {errorMatching} from './helpers/error-matching.js';
import {rejects} from './helpers/rejects.js';
import withServer from './helpers/with-server.js';

test('emits request event as promise', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end('null');
	});

	let calls = 0;
	await got('').json().on('request', (request: ClientRequest) => {
		calls++;
		assert.strictEqual(request instanceof ClientRequest, true);
	});

	assert.strictEqual(calls, 1);
});

test('emits response event as promise', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end('null');
	});

	let calls = 0;
	await got('').json().on('response', (response: Response) => {
		calls++;
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.readable, false);
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.ip === '127.0.0.1' || response.ip === '::1', true);
	});

	assert.strictEqual(calls, 1);
});

test('returns Uint8Array on compressed response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end();
	});

	const {body} = await got({decompress: false});

	assert.strictEqual(ArrayBuffer.isView(body), true, 'Expected Uint8Array response body when `decompress` is false for compressed responses');

	if (!ArrayBuffer.isView(body)) {
		return;
	}

	assert.strictEqual(body.constructor.name, 'Uint8Array');

	assert.strictEqual(Buffer.isBuffer(body), false);
});

test('no unhandled `The server aborted pending request` rejection', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.write('asdf');

		setTimeout(() => {
			response.end();
		}, 100);
	});

	await assert.rejects(got(''));
});

test('promise.json() can be called before a file stream body is open', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.end('""');
		});
	});

	// @ts-expect-error @types/node has wrong types.
	const body = new ReadStream('', {
		fs: {
			open() {},
			read() {},
			close() {},
		},
	});

	const controller = new AbortController();

	const promise = got({body, signal: controller.signal});
	const checks = [
		rejects(promise, errorMatching(AbortError, {code: 'ERR_ABORTED'})),
		rejects(promise.json(), errorMatching(AbortError, {code: 'ERR_ABORTED'})),
	];

	controller.abort();

	await Promise.all(checks);
});

test('promise.json() does not fail when server returns an error', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('{}');
	});

	const promise = got('', {throwHttpErrors: false});
	await assert.doesNotReject(promise.json());
});

test('followRedirect is not called for a successful response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('success');
	});

	let calls = 0;
	const response = await got('', {
		followRedirect() {
			calls++;
			return true;
		},
	});

	assert.strictEqual(response.body, 'success');
	assert.strictEqual(response.ok, true);
	assert.strictEqual(calls, 0);
});

for (const statusCode of [204, 304, 400, 503]) {
	test(`followRedirect does not decide acceptance of status ${statusCode}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = statusCode;
			response.end();
		});

		const response = await got('', {
			throwHttpErrors: false,
			retry: {limit: 0},
			followRedirect() {
				throw new Error('Only redirect responses can be evaluated');
			},
		});

		assert.strictEqual(response.statusCode, statusCode);
		assert.strictEqual(response.ok, statusCode === 204 || statusCode === 304);
	});
}

test('followRedirect receives redirects before a successful final response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/target');
	});
	server.get('/target', (_request, response) => {
		response.end('target');
	});

	const statuses: number[] = [];
	const response = await got('', {
		followRedirect(response) {
			statuses.push(response.statusCode);
			return response.headers.location === '/target';
		},
	});

	assert.strictEqual(response.body, 'target');
	assert.strictEqual(statuses.length > 0, true);
	assert.strictEqual(statuses.every(status => status === 302), true);
});

test('response.ok reflects a status recovered by an afterResponse hook', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('missing');
	});

	const response = await got('', {
		hooks: {
			afterResponse: [response => {
				response.statusCode = 200;
				response.body = 'fallback';
				return response;
			}],
		},
	});

	assert.strictEqual(response.body, 'fallback');
	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.ok, true);
});

for (const throwHttpErrors of [false, true]) {
	test(`response.ok reflects hook-created errors with throwHttpErrors ${throwHttpErrors}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('application error');
		});

		const promise = got('', {
			throwHttpErrors,
			retry: {limit: 0},
			hooks: {
				afterResponse: [response => {
					response.statusCode = 400;
					return response;
				}],
			},
		});
		const response = throwHttpErrors
			? (await rejects(promise, HTTPError)).response
			: await promise;

		assert.strictEqual(response.statusCode, 400);
		assert.strictEqual(response.body, 'application error');
		assert.strictEqual(response.ok, false);
	});
}

for (const statusCode of [204, 304, 302]) {
	test(`response.ok accepts hook-recovered status ${statusCode}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = 404;
			response.end();
		});

		const response = await got('', {
			followRedirect: false,
			hooks: {
				afterResponse: [response => {
					response.statusCode = statusCode;
					return response;
				}],
			},
		});

		assert.strictEqual(response.statusCode, statusCode);
		assert.strictEqual(response.ok, true);
	});
}

test('JSON shortcuts parse HTTP errors suppressed after response hooks', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{"error":"application failure"}');
	});
	const promise = got('', {
		throwHttpErrors: false,
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => {
				response.statusCode = 400;
				throw new HTTPError(response);
			}],
		},
	});
	assert.strictEqual((await promise).statusCode, 400);
	assert.deepStrictEqual(await promise.json(), {error: 'application failure'});
});

for (const resolveBodyOnly of [false, true]) {
	test(`all shortcuts support suppressed hook errors with resolveBodyOnly ${resolveBodyOnly}`, withServer, async (_t, server, got) => {
		const body = '{"error":"application failure"}';
		server.get('/', (_request, response) => {
			response.end(body);
		});
		const promise = got('', {
			throwHttpErrors: false,
			resolveBodyOnly,
			retry: {limit: 0},
			hooks: {
				afterResponse: [response => {
					response.statusCode = 400;
					throw new HTTPError(response);
				}],
			},
		});

		const [text, json, buffer] = await Promise.all([promise.text(), promise.json(), promise.buffer()]);
		assert.strictEqual(text, body);
		assert.deepStrictEqual(json, {error: 'application failure'});
		assert.deepStrictEqual(buffer, new TextEncoder().encode(body));
	});
}

test('suppressed hook HTTP errors refresh response success metadata', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('application failure');
	});
	const response = await got('', {
		throwHttpErrors: false,
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => {
				response.statusCode = 400;
				throw new HTTPError(response);
			}],
		},
	});

	assert.strictEqual(response.statusCode, 400);
	assert.strictEqual(response.ok, false);
	assert.strictEqual(response.request.response, response);
});

for (const statusCode of [200, 304, 302, 503]) {
	test(`suppressed hook HTTP errors use normal success rules for status ${statusCode}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = 400;
			response.end('response body');
		});
		const response = await got('', {
			throwHttpErrors: false,
			followRedirect: false,
			retry: {limit: 0},
			hooks: {
				afterResponse: [response => {
					assert.strictEqual(response.ok, false);
					response.statusCode = statusCode;
					throw new HTTPError(response);
				}],
			},
		});

		assert.strictEqual(response.statusCode, statusCode);
		assert.strictEqual(response.ok, statusCode < 400);
		assert.strictEqual(response.body, 'response body');
	});
}

test('suppressed HTTP errors attach their replacement response to the request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.json({original: true});
	});
	const body = JSON.stringify({replacement: true});
	const promise = got('', {
		throwHttpErrors: false,
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => {
				const replacement = Object.assign(Object.create(response) as typeof response, {
					statusCode: 400,
					body,
					rawBody: new TextEncoder().encode(body),
				});
				throw new HTTPError(replacement);
			}],
		},
	});

	const response = await promise;
	assert.strictEqual(response.ok, false);
	assert.strictEqual(response.request.response, response);
	assert.strictEqual(response.body, body);
	assert.deepStrictEqual(await promise.json(), {replacement: true});
});

test('shortcuts preserve hook HTTP errors when throwing is enabled', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});
	const promise = got('', {
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => {
				response.statusCode = 400;
				throw new HTTPError(response);
			}],
		},
	});

	const errors = await Promise.all([promise, promise.json(), promise.text(), promise.buffer()].map(async result => rejects(result, HTTPError)));
	assert.strictEqual(errors.every(error => error === errors[0]), true);
});

test('shortcuts use the last response after suppressed hook error retries', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end(JSON.stringify({attempt: requests}));
	});

	const result = await got('', {
		throwHttpErrors: false,
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			afterResponse: [response => {
				response.statusCode = 503;
				throw new HTTPError(response);
			}],
		},
	}).json();

	assert.strictEqual(requests, 2);
	assert.deepStrictEqual(result, {attempt: 2});
});

test('a dynamic redirect allowance is used for routing', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/target');
	});
	server.get('/target', (_request, response) => {
		response.end('target');
	});

	let remainingRedirects = 1;
	const response = await got('', {
		followRedirect() {
			return remainingRedirects-- > 0;
		},
	});

	assert.strictEqual(response.body, 'target');
	assert.strictEqual(response.statusCode, 200);
});

for (const followRedirect of [true, false]) {
	for (const usePredicate of [true, false]) {
		test(`redirect routing honors ${followRedirect} with predicate ${usePredicate}`, withServer, async (_t, server, got) => {
			const paths: string[] = [];
			server.get('/', (request, response) => {
				paths.push(request.path);
				response.redirect('/target');
			});
			server.get('/target', (request, response) => {
				paths.push(request.path);
				response.end('target');
			});

			const response = await got('', {followRedirect: usePredicate ? () => followRedirect : followRedirect});

			assert.strictEqual(response.statusCode, followRedirect ? 200 : 302);
			assert.strictEqual(response.ok, true);
			assert.deepStrictEqual(paths, followRedirect ? ['/', '/target'] : ['/']);
		});
	}

	test(`redirect responses without a Location retain predicate acceptance ${followRedirect}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = 302;
			response.end('no location');
		});

		const request = got('', {followRedirect: () => followRedirect});
		const response = followRedirect
			? (await rejects(request, HTTPError)).response
			: await request;

		assert.strictEqual(response.statusCode, 302);
		assert.strictEqual(response.body, 'no location');
		assert.strictEqual(response.ok, !followRedirect);
	});
}

for (const allowance of [0, 1, 2]) {
	test(`dynamic redirect allowances follow exactly ${allowance} redirects in a chain`, withServer, async (_t, server, got) => {
		const paths: string[] = [];
		server.get('/:step', (request, response) => {
			paths.push(request.path);
			response.redirect(`/${Number(request.params.step) + 1}`);
		});

		let remainingRedirects = allowance;
		const response = await got('0', {
			followRedirect() {
				return remainingRedirects-- > 0;
			},
		});

		assert.strictEqual(response.statusCode, 302);
		assert.strictEqual(response.ok, true);
		assert.strictEqual(response.headers.location, `/${allowance + 1}`);
		assert.deepStrictEqual(paths, Array.from({length: allowance + 1}, (_, index) => `/${index}`));
		assert.strictEqual(response.redirectUrls.length, allowance);
	});
}

test('manual retries skip response hooks that already ran by default', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.end(String(++requests));
	});
	const hookCalls: string[] = [];
	const response = await got('', {
		hooks: {
			afterResponse: [
				response => {
					hookCalls.push(`first:${String(response.body)}`);
					return response;
				},
				(_response, retryWithMergedOptions) => {
					hookCalls.push('retry');
					return retryWithMergedOptions({});
				},
				response => {
					hookCalls.push('remaining');
					return response;
				},
			],
		},
	});

	assert.strictEqual(response.body, '2');
	assert.strictEqual(response.retryCount, 1);
	assert.deepStrictEqual(hookCalls, ['first:1', 'retry']);
	assert.strictEqual(requests, 2);
});

test('explicit preserveHooks false skips asynchronous response hooks but runs beforeRetry', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.json({attempt: ++requests});
	});
	let responseHookCalls = 0;
	let retryHookCalls = 0;
	const promise = got('', {
		hooks: {
			afterResponse: [
				async response => {
					await Promise.resolve();
					responseHookCalls++;
					return response;
				},
				(_response, retryWithMergedOptions) => retryWithMergedOptions({preserveHooks: false}),
			],
			beforeRetry: [() => {
				retryHookCalls++;
			}],
		},
	});

	assert.deepStrictEqual(await promise.json(), {attempt: 2});
	assert.strictEqual((await promise).retryCount, 1);
	assert.strictEqual(responseHookCalls, 1);
	assert.strictEqual(retryHookCalls, 1);
});

test('skipping retry response hooks does not modify instance defaults', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('done');
	});
	let firstHookCalls = 0;
	let retryHookCalls = 0;
	const client = got.extend({
		hooks: {
			afterResponse: [
				response => {
					firstHookCalls++;
					return response;
				},
				(_response, retryWithMergedOptions) => {
					retryHookCalls++;
					return retryWithMergedOptions({});
				},
			],
		},
	});

	const first = await client('');
	const second = await client('');
	assert.strictEqual(first.retryCount, 1);
	assert.strictEqual(second.retryCount, 1);
	assert.strictEqual(firstHookCalls, 2);
	assert.strictEqual(retryHookCalls, 2);
	assert.strictEqual(client.defaults.options.hooks.afterResponse.length, 2);
});

test('automatic HTTP retries still run response hooks for each attempt', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		response.statusCode = ++requests === 1 ? 503 : 200;
		response.end('done');
	});
	const hookCalls: string[] = [];
	const response = await got('', {
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			afterResponse: [
				response => {
					hookCalls.push(`first:${response.statusCode}`);
					return response;
				},
				response => {
					hookCalls.push(`second:${response.statusCode}`);
					return response;
				},
			],
		},
	});

	assert.strictEqual(response.body, 'done');
	assert.strictEqual(response.retryCount, 1);
	assert.deepStrictEqual(hookCalls, ['first:503', 'second:503', 'first:200', 'second:200']);
});

test('manual retry with new JSON preserves an explicit content type', withServer, async (_t, server, got) => {
	const contentTypes: Array<string | undefined> = [];
	const bodies: string[] = [];
	server.post('/', async (request, response) => {
		contentTypes.push(request.headers['content-type']);
		bodies.push(await getStream(request));
		response.end('done');
	});

	await got.post('', {
		json: {attempt: 1},
		headers: {'content-type': 'application/vnd.api+json'},
		hooks: {
			afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({json: {attempt: 2}})],
		},
	});

	assert.deepStrictEqual(bodies, ['{"attempt":1}', '{"attempt":2}']);
	assert.deepStrictEqual(contentTypes, ['application/vnd.api+json', 'application/vnd.api+json']);
});
