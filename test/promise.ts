import {Buffer} from 'node:buffer';
import {ReadStream} from 'node:fs';
import {ClientRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import {
	type Response,
	type StandardSchemaV1,
	AbortError,
	HTTPError,
	ParseError,
	SchemaValidationError,
} from '../source/index.js';
import test from './helpers/test.js';
import {errorMatching} from './helpers/error-matching.js';
import {rejects} from './helpers/rejects.js';
import withServer from './helpers/with-server.js';

const invalidSchemaMessage = 'The `schema` argument must follow the Standard Schema specification';

const createSchema = <OutputType>(validate: StandardSchemaV1<unknown, OutputType>['~standard']['validate']): StandardSchemaV1<unknown, OutputType> => ({
	'~standard': {
		version: 1,
		vendor: 'test',
		validate,
	},
});

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

test('promise response event carries only the final response', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		response.statusCode = requestCount === 1 ? 500 : 200;
		response.end(`attempt ${requestCount}`);
	});

	const statuses: number[] = [];
	const response = await got('', {retry: {limit: 1, calculateDelay: () => 1}}).once('response', (response: Response) => {
		statuses.push(response.statusCode);
	});

	assert.strictEqual(response.statusCode, 200);
	assert.deepStrictEqual(statuses, [200]);
});

test('promise response event fires for a non-ok response when errors are not thrown', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('nope');
	});

	const statuses: number[] = [];
	const response = await got('', {throwHttpErrors: false}).once('response', (response: Response) => {
		statuses.push(response.statusCode);
	});

	assert.strictEqual(response.statusCode, 404);
	assert.deepStrictEqual(statuses, [404]);
});

for (const [name, statusCode, options] of [
	['an ok response', 200, {}],
	['a non-ok response that is not thrown', 404, {throwHttpErrors: false}],
] as const) {
	test(`a throwing promise response listener rejects the promise: ${name}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.statusCode = statusCode;
			response.end('body');
		});

		const listenerError = new Error('listener threw');
		const error = await rejects(got('', {...options, retry: {limit: 0}}).on('response', () => {
			throw listenerError;
		}));

		assert.strictEqual(error, listenerError);
	});
}

test('the body shortcuts can be called repeatedly on one promise without another request', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.setHeader('content-type', 'application/json');
		response.end('{"value":1}');
	});

	const promise = got('');
	const firstJson = await promise.json<{value: number}>();
	const secondJson = await promise.json<{value: number}>();
	const text = await promise.text();
	const buffer = await promise.buffer();

	assert.strictEqual(requests, 1);
	assert.deepStrictEqual(firstJson, {value: 1});
	assert.deepStrictEqual(secondJson, {value: 1});
	assert.strictEqual(text, '{"value":1}');
	assert.ok(buffer instanceof Uint8Array);
	assert.strictEqual(new TextDecoder().decode(buffer), '{"value":1}');
	assert.strictEqual((await promise).body, '{"value":1}');
});

test('promise redirect events precede a single response event for the final response', withServer, async (_t, server, got) => {
	server.get('/one', (_request, response) => {
		response.writeHead(302, {location: '/two'}).end();
	});
	server.get('/two', (_request, response) => {
		response.writeHead(302, {location: '/three'}).end();
	});
	server.get('/three', (_request, response) => {
		response.end('reached');
	});

	const events: string[] = [];
	await got('one')
		.on('redirect', (_options, response: Response) => {
			events.push(`redirect ${response.statusCode} ${new URL(response.url).pathname}`);
		})
		.on('response', (response: Response) => {
			events.push(`response ${response.statusCode} ${new URL(response.url).pathname}`);
		});

	assert.deepStrictEqual(events, [
		'redirect 302 /one',
		'redirect 302 /two',
		'response 200 /three',
	]);
});

test('the promise response event does not fire when the promise rejects with an HTTPError', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('missing');
	});

	let responseEvents = 0;
	await assert.rejects(got('', {retry: {limit: 0}}).on('response', () => {
		responseEvents++;
	}), HTTPError);

	assert.strictEqual(responseEvents, 0);
});

test('promise.json(schema) validates the parsed body and resolves with the schema output', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 1}));
	});

	let receivedValue: unknown;
	const schema = createSchema<{doubled: number}>(value => {
		receivedValue = value;
		return {value: {doubled: 2}};
	});

	assert.deepStrictEqual(await got('').json(schema), {doubled: 2});
	assert.deepStrictEqual(receivedValue, {value: 1});
});

test('promise.json(undefined) parses JSON without validating', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 1}));
	});

	assert.deepStrictEqual(await got('').json(undefined), {value: 1});
});

test('promise.json(schema) throws SchemaValidationError when validation fails', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 'one'}));
	});

	const issues = [{message: 'Expected number, received string', path: ['value']}];
	const schema = createSchema(() => ({issues}));

	const error = await rejects<SchemaValidationError>(
		got('').json(schema),
		errorMatching(SchemaValidationError, {message: 'Response schema validation failed'}),
	);

	assert.deepStrictEqual(error.issues, issues);
});

test('promise.json(schema) supports async validators', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 1}));
	});

	const schema = createSchema<number>(async value => {
		await delay(1);

		return {value: (value as {value: number}).value};
	});

	assert.strictEqual(await got('').json(schema), 1);
});

test('promise.json(schema) validates the result of the `parseJson` option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('not json');
	});

	let receivedValue: unknown;
	const schema = createSchema<string>(value => {
		receivedValue = value;
		return {value: 'validated'};
	});

	const body = await got('', {
		parseJson: () => ({value: 'parsed'}),
	}).json(schema);

	assert.strictEqual(body, 'validated');
	assert.deepStrictEqual(receivedValue, {value: 'parsed'});
});

test('promise.json(schema) rejects with a ParseError when the `parseJson` option throws', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('not json');
	});

	const schema = createSchema(() => {
		assert.fail('The schema must not run when parsing fails');
	});

	const parseFailure = new Error('Custom parse failure');

	const error = await rejects<ParseError>(got('', {
		parseJson() {
			throw parseFailure;
		},
	}).json(schema), errorMatching(ParseError, {code: 'ERR_BODY_PARSE_FAILURE'}));

	assert.strictEqual(error.cause, parseFailure);
});

test('promise.json(schema) rejects with the error the schema throws', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const thrown = new Error('Validator failure');
	const schema = createSchema(() => {
		throw thrown;
	});

	const error = await rejects(got('').json(schema));

	assert.strictEqual(error, thrown);
});

for (const [label, value] of [
	['an object without `~standard`', {}],
	['`null`', null],
	['a `~standard.validate` that is not a function', {'~standard': {version: 1, vendor: 'test', validate: 'nope'}}],
] as const) {
	test(`promise.json(schema) throws a TypeError for ${label}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('{}');
		});

		// @ts-expect-error Testing invalid input.
		await rejects(got('').json(value), errorMatching(TypeError, {message: invalidSchemaMessage}));
	});
}

test('promise.json(schema) still rejects an HTTP error response before validating', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('{}');
	});

	const schema = createSchema(() => {
		assert.fail('The schema must not run for an HTTP error');
	});

	await rejects(got('').json(schema), errorMatching(HTTPError, {code: 'ERR_NON_2XX_3XX_RESPONSE'}));
});

test('promise.json(schema) validates an HTTP error response when `throwHttpErrors` is `false`', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end(JSON.stringify({error: 'missing'}));
	});

	let receivedValue: unknown;
	const issues = [{message: 'Expected `ok`'}];
	const schema = createSchema(value => {
		receivedValue = value;
		return {issues};
	});

	const error = await rejects<SchemaValidationError>(
		got('', {throwHttpErrors: false}).json(schema),
		errorMatching(SchemaValidationError, {message: 'Response schema validation failed'}),
	);

	assert.deepStrictEqual(error.issues, issues);
	assert.deepStrictEqual(receivedValue, {error: 'missing'});
});

test('promise.json(schema) treats an empty issues list as a validation failure', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const error = await rejects<SchemaValidationError>(
		got('').json(createSchema(() => ({issues: []}))),
		errorMatching(SchemaValidationError, {message: 'Response schema validation failed'}),
	);

	assert.deepStrictEqual(error.issues, []);
});

test('promise.json(schema) resolves with a falsy schema output', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	for (const value of [undefined, null, 0, false, '']) {
		// eslint-disable-next-line no-await-in-loop
		assert.strictEqual(await got('').json(createSchema(() => ({value, issues: undefined}))), value);
	}
});

test('promise.json(schema) validates each call independently and does not reject the request promise', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 1}));
	});

	const promise = got('');
	const failingSchema = createSchema(() => ({issues: [{message: 'Expected a string'}]}));
	const passingSchema = createSchema<number>(value => ({value: (value as {value: number}).value}));

	const [, result, response] = await Promise.all([
		rejects(promise.json(failingSchema), errorMatching(SchemaValidationError, {message: 'Response schema validation failed'})),
		promise.json(passingSchema),
		promise,
	]);

	assert.strictEqual(result, 1);
	assert.strictEqual(response.statusCode, 200);
});

test('promise.json(schema) validates only the final response after a retry, and a validation failure does not retry', withServer, async (_t, server, got) => {
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		response.statusCode = requestCount === 1 ? 500 : 200;
		response.end(JSON.stringify({attempt: requestCount}));
	});

	const receivedValues: unknown[] = [];
	const schema = createSchema(value => {
		receivedValues.push(value);
		return {issues: [{message: 'Expected something else'}]};
	});

	await rejects(
		got('', {retry: {limit: 2, backoffLimit: 0, noise: 0}}).json(schema),
		errorMatching(SchemaValidationError, {message: 'Response schema validation failed'}),
	);

	assert.strictEqual(requestCount, 2);
	assert.deepStrictEqual(receivedValues, [{attempt: 2}]);
});

test('promise.json(schema) works through a handler that recovers an HTTP error response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end(JSON.stringify({error: 'missing'}));
	});

	const instance = got.extend({
		handlers: [
			async (options, next) => {
				try {
					return await next(options);
				} catch (error) {
					if (error instanceof HTTPError) {
						return error.response as Awaited<ReturnType<typeof next>>;
					}

					throw error;
				}
			},
		],
	});

	let receivedValue: unknown;
	const schema = createSchema<string>(value => {
		receivedValue = value;
		return {value: 'validated'};
	});

	assert.strictEqual(await instance('').json(schema), 'validated');
	assert.deepStrictEqual(receivedValue, {error: 'missing'});
});

test('promise.json(schema) keeps the caller in the error stack', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const schema = createSchema(() => ({issues: [{message: 'Expected an object'}]}));

	async function schemaValidationCaller() {
		await got('').json(schema);
	}

	const error = await rejects(schemaValidationCaller());

	assert.ok(error instanceof SchemaValidationError);
	assert.match(error.stack ?? '', /schemaValidationCaller/v);
});

test('promise.json(schema) does not run `beforeError` hooks', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	let calls = 0;

	const error = await rejects<SchemaValidationError>(got('', {
		hooks: {
			beforeError: [
				() => {
					calls++;
					return new Error('replaced');
				},
			],
		},
	}).json(createSchema(() => ({issues: [{message: 'Expected an object'}]}))));

	assert.ok(error instanceof SchemaValidationError);
	assert.strictEqual(calls, 0);
});

test('promise.json(schema) accepts a callable schema', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 1}));
	});

	// Some validators, such as ArkType, return a callable schema object.
	const schema = Object.assign(
		() => {},
		{
			'~standard': {
				version: 1 as const,
				vendor: 'test',
				validate: (value: unknown) => ({value: {received: value}}),
			},
		},
	);

	assert.deepStrictEqual(await got('').json(schema), {received: {value: 1}});
});

test('promise.json(schema) receives an empty string for an empty body', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	let receivedValue: unknown;
	const schema = createSchema<string>(value => {
		receivedValue = value;
		return {value: 'empty'};
	});

	assert.strictEqual(await got('').json(schema), 'empty');
	assert.strictEqual(receivedValue, '');
});

test('promise.json(schema) validates when `resolveBodyOnly` is enabled', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify({value: 1}));
	});

	let receivedValue: unknown;
	const schema = createSchema<string>(value => {
		receivedValue = value;
		return {value: 'validated'};
	});

	assert.strictEqual(await got('', {resolveBodyOnly: true}).json(schema), 'validated');
	assert.deepStrictEqual(receivedValue, {value: 1});
});
