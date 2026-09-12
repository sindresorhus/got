import {Buffer} from 'node:buffer';
import {ReadStream} from 'node:fs';
import {ClientRequest} from 'node:http';
import test from 'ava';
import {type Response, AbortError, HTTPError} from '../source/index.js';
import withServer from './helpers/with-server.js';

test('emits request event as promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end('null');
	});

	await got('').json().on('request', (request: ClientRequest) => {
		t.true(request instanceof ClientRequest);
	});
});

test('emits response event as promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end('null');
	});

	await got('').json().on('response', (response: Response) => {
		t.is(response.statusCode, 200);
		t.false(response.readable);
		t.is(response.statusCode, 200);
		t.true(response.ip === '127.0.0.1' || response.ip === '::1');
	});
});

test('returns Uint8Array on compressed response', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end();
	});

	const {body} = await got({decompress: false});

	t.true(ArrayBuffer.isView(body), 'Expected Uint8Array response body when `decompress` is false for compressed responses');

	if (!ArrayBuffer.isView(body)) {
		return;
	}

	t.is(body.constructor.name, 'Uint8Array');

	t.false(Buffer.isBuffer(body));
});

test('no unhandled `The server aborted pending request` rejection', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.write('asdf');

		setTimeout(() => {
			response.end();
		}, 100);
	});

	await t.throwsAsync(got(''));
});

test('promise.json() can be called before a file stream body is open', withServer, async (t, server, got) => {
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
		t.throwsAsync(promise, {
			instanceOf: AbortError,
			code: 'ERR_ABORTED',
		}),
		t.throwsAsync(promise.json(), {
			instanceOf: AbortError,
			code: 'ERR_ABORTED',
		}),
	];

	controller.abort();

	await Promise.all(checks);
});

test('promise.json() does not fail when server returns an error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('{}');
	});

	const promise = got('', {throwHttpErrors: false});
	await t.notThrowsAsync(promise.json());
});

test('followRedirect is not called for a successful response', withServer, async (t, server, got) => {
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

	t.is(response.body, 'success');
	t.true(response.ok);
	t.is(calls, 0);
});

for (const statusCode of [204, 304, 400, 503]) {
	test(`followRedirect does not decide acceptance of status ${statusCode}`, withServer, async (t, server, got) => {
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

		t.is(response.statusCode, statusCode);
		t.is(response.ok, statusCode === 204 || statusCode === 304);
	});
}

test('followRedirect receives redirects before a successful final response', withServer, async (t, server, got) => {
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

	t.is(response.body, 'target');
	t.true(statuses.length > 0);
	t.true(statuses.every(status => status === 302));
});

test('response.ok reflects a status recovered by an afterResponse hook', withServer, async (t, server, got) => {
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

	t.is(response.body, 'fallback');
	t.is(response.statusCode, 200);
	t.true(response.ok);
});

for (const throwHttpErrors of [false, true]) {
	test(`response.ok reflects hook-created errors with throwHttpErrors ${throwHttpErrors}`, withServer, async (t, server, got) => {
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
			? (await t.throwsAsync<HTTPError>(promise, {instanceOf: HTTPError})).response
			: await promise;

		t.is(response.statusCode, 400);
		t.is(response.body, 'application error');
		t.false(response.ok);
	});
}

for (const statusCode of [204, 304, 302]) {
	test(`response.ok accepts hook-recovered status ${statusCode}`, withServer, async (t, server, got) => {
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

		t.is(response.statusCode, statusCode);
		t.true(response.ok);
	});
}

test('JSON shortcuts parse HTTP errors suppressed after response hooks', withServer, async (t, server, got) => {
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
	t.is((await promise).statusCode, 400);
	t.deepEqual(await promise.json(), {error: 'application failure'});
});

for (const resolveBodyOnly of [false, true]) {
	test(`all shortcuts support suppressed hook errors with resolveBodyOnly ${resolveBodyOnly}`, withServer, async (t, server, got) => {
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
		t.is(text, body);
		t.deepEqual(json, {error: 'application failure'});
		t.deepEqual(buffer, new TextEncoder().encode(body));
	});
}

test('suppressed hook HTTP errors refresh response success metadata', withServer, async (t, server, got) => {
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

	t.is(response.statusCode, 400);
	t.false(response.ok);
	t.is(response.request.response, response);
});

for (const statusCode of [200, 304, 302, 503]) {
	test(`suppressed hook HTTP errors use normal success rules for status ${statusCode}`, withServer, async (t, server, got) => {
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
					t.false(response.ok);
					response.statusCode = statusCode;
					throw new HTTPError(response);
				}],
			},
		});

		t.is(response.statusCode, statusCode);
		t.is(response.ok, statusCode < 400);
		t.is(response.body, 'response body');
	});
}

test('suppressed HTTP errors attach their replacement response to the request', withServer, async (t, server, got) => {
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
	t.false(response.ok);
	t.is(response.request.response, response);
	t.is(response.body, body);
	t.deepEqual(await promise.json(), {replacement: true});
});

test('shortcuts preserve hook HTTP errors when throwing is enabled', withServer, async (t, server, got) => {
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

	const errors = await Promise.all([promise, promise.json(), promise.text(), promise.buffer()].map(async result => t.throwsAsync(result, {instanceOf: HTTPError})));
	t.true(errors.every(error => error === errors[0]));
});

test('shortcuts use the last response after suppressed hook error retries', withServer, async (t, server, got) => {
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

	t.is(requests, 2);
	t.deepEqual(result, {attempt: 2});
});

test('a dynamic redirect allowance is used for routing', withServer, async (t, server, got) => {
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

	t.is(response.body, 'target');
	t.is(response.statusCode, 200);
});

for (const followRedirect of [true, false]) {
	for (const usePredicate of [true, false]) {
		test(`redirect routing honors ${followRedirect} with predicate ${usePredicate}`, withServer, async (t, server, got) => {
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

			t.is(response.statusCode, followRedirect ? 200 : 302);
			t.true(response.ok);
			t.deepEqual(paths, followRedirect ? ['/', '/target'] : ['/']);
		});
	}

	test(`redirect responses without a Location retain predicate acceptance ${followRedirect}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = 302;
			response.end('no location');
		});

		const request = got('', {followRedirect: () => followRedirect});
		const response = followRedirect
			? (await t.throwsAsync<HTTPError>(request, {instanceOf: HTTPError})).response
			: await request;

		t.is(response.statusCode, 302);
		t.is(response.body, 'no location');
		t.is(response.ok, !followRedirect);
	});
}

for (const allowance of [0, 1, 2]) {
	test(`dynamic redirect allowances follow exactly ${allowance} redirects in a chain`, withServer, async (t, server, got) => {
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

		t.is(response.statusCode, 302);
		t.true(response.ok);
		t.is(response.headers.location, `/${allowance + 1}`);
		t.deepEqual(paths, Array.from({length: allowance + 1}, (_, index) => `/${index}`));
		t.is(response.redirectUrls.length, allowance);
	});
}

test('manual retries skip response hooks that already ran by default', withServer, async (t, server, got) => {
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

	t.is(response.body, '2');
	t.is(response.retryCount, 1);
	t.deepEqual(hookCalls, ['first:1', 'retry']);
	t.is(requests, 2);
});

test('explicit preserveHooks false skips asynchronous response hooks but runs beforeRetry', withServer, async (t, server, got) => {
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

	t.deepEqual(await promise.json(), {attempt: 2});
	t.is((await promise).retryCount, 1);
	t.is(responseHookCalls, 1);
	t.is(retryHookCalls, 1);
});

test('skipping retry response hooks does not modify instance defaults', withServer, async (t, server, got) => {
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
	t.is(first.retryCount, 1);
	t.is(second.retryCount, 1);
	t.is(firstHookCalls, 2);
	t.is(retryHookCalls, 2);
	t.is(client.defaults.options.hooks.afterResponse.length, 2);
});

test('automatic HTTP retries still run response hooks for each attempt', withServer, async (t, server, got) => {
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

	t.is(response.body, 'done');
	t.is(response.retryCount, 1);
	t.deepEqual(hookCalls, ['first:503', 'second:503', 'first:200', 'second:200']);
});
