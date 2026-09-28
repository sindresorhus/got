import {Buffer} from 'node:buffer';
import http from 'node:http';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import {Agent} from 'node:https';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import is from '@sindresorhus/is';
import got, {
	Options,
	RequestError,
	HTTPError,
	TimeoutError,
	ParseError,
	ReadError,
	UploadError,
	CacheError,
	type Response,
} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';
import invalidUrl from './helpers/invalid-url.js';

test('properties', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const url = new URL(server.url);

	const error = (await rejects(got('')));
	assert.ok(error);
	assert.ok(error.response);
	assert.ok(error.options);
	assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, 'options'), true);
	assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, 'response'), false);
	assert.strictEqual(error.code, 'ERR_NON_2XX_3XX_RESPONSE');
	assert.match(error.message, /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v);
	assert.deepStrictEqual(error.options.url, url);
	assert.strictEqual(error.response.headers.connection, 'keep-alive');
	// Assert is used for type checking
	assert.strictEqual(error.response.body, 'not');
});

test('catches dns errors', async _t => {
	const error = (await rejects(got('http://doesntexist', {retry: {limit: 0}})));
	assert.ok(error);
	assert.match(error.message, /ENOTFOUND|EAI_AGAIN/v);
	assert.strictEqual((error.options.url as URL).host, 'doesntexist');
	assert.strictEqual(error.options.method, 'GET');
	assert.strictEqual(['ENOTFOUND', 'EAI_AGAIN'].includes(error.code), true);
});

test('`options.body` form error message', async _t => {
	await assert.rejects(
		got.post('https://example.com', {body: Buffer.from('test'), form: '' as any}),
		errorMatching(RequestError, {message: 'Option \'form\': Expected values which are `plain object` or `undefined`. Received values of type `string`.'}),
		// {message: 'The `body`, `json` and `form` options are mutually exclusive'}
	);
});

test('no plain object restriction on json body', withServer, async (_t, server, got) => {
	server.post('/body', async (request, response) => {
		await streamPipeline(request, response);
	});

	class CustomObject {
		a = 123;
	}

	const body = await got.post('body', {json: new CustomObject()}).json();

	assert.deepStrictEqual(body, {a: 123});
});

test('default status message', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	const error = await rejects(
		got(''),
		errorMatching(HTTPError, {message: /^Request failed with status code 400 \(Bad Request\): GET http:\/\/localhost:\d+\/$/v}),
	);
	assert.strictEqual(error?.response.statusCode, 400);
	assert.strictEqual(error?.response.statusMessage, 'Bad Request');
});

test('custom status message', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.statusMessage = 'Something Exploded';
		response.end('body');
	});

	const error = await rejects(
		got(''),
		errorMatching(HTTPError, {message: /^Request failed with status code 400 \(Something Exploded\): GET http:\/\/localhost:\d+\/$/v}),
	);
	assert.strictEqual(error?.response.statusCode, 400);
	assert.strictEqual(error?.response.statusMessage, 'Something Exploded');
});

test('credentials are stripped from HTTPError message URL', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	const error = await rejects(
		got('', {username: 'user', password: 'secret'}),
		HTTPError,
	);
	assert.strictEqual(error?.message.includes('user'), false);
	assert.strictEqual(error?.message.includes('secret'), false);
	assert.match(error?.message ?? '', /^Request failed with status code 400 \(Bad Request\): GET http:\/\/localhost:\d+\/$/v);
});

test('custom body', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await rejects(
		got(''),
		errorMatching(HTTPError, {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v}),
	);
	assert.strictEqual(error?.response.statusCode, 404);
	// Typecheck for default `any` type
	assert.strictEqual(error?.response.body, 'not');
});

test('custom json body', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.header('content-type', 'application/json');
		response.end(JSON.stringify({
			message: 'not found',
		}));
	});

	const error = await rejects(
		got('', {responseType: 'json'}),
		errorMatching(HTTPError, {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v}),
	);
	assert.strictEqual(error?.response.statusCode, 404);
	// Assert is used for body typecheck
	assert.strictEqual(error?.response.body.message, 'not found');
});

test('HTTP errors preserve the replacement response returned by a hook', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const error = await rejects(got('', {
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => Object.assign(Object.create(response) as typeof response, {statusCode: 400, body: 'application failure'})],
		},
	}), HTTPError);

	assert.strictEqual(error.response.statusCode, 400);
	assert.strictEqual(error.response.body, 'application failure');
});

for (const resolveBodyOnly of [false, true]) {
	test(`suppressed HTTP errors preserve replacement responses with resolveBodyOnly ${resolveBodyOnly}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('original');
		});

		const result = await got('', {
			throwHttpErrors: false,
			resolveBodyOnly,
			retry: {limit: 0},
			hooks: {
				afterResponse: [response => Object.assign(Object.create(response) as typeof response, {statusCode: 400, body: 'application failure'})],
			},
		});

		if (resolveBodyOnly) {
			assert.strictEqual(result, 'application failure');
		} else {
			const response = result as Response;
			assert.strictEqual(response.statusCode, 400);
			assert.strictEqual(response.body, 'application failure');
			assert.strictEqual(response.ok, false);
		}
	});
}

test('replacement response status codes control retries', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end('success');
	});

	const response = await got('', {
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		hooks: {
			afterResponse: [response => requests === 1
				? Object.assign(Object.create(response) as typeof response, {statusCode: 503, body: 'retry'})
				: response],
		},
	});

	assert.strictEqual(requests, 2);
	assert.strictEqual(response.body, 'success');
	assert.strictEqual(response.retryCount, 1);
});

test('successful replacement responses remain attached to their request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const response = await got('', {
		hooks: {
			afterResponse: [response => Object.assign(Object.create(response) as typeof response, {body: 'replacement'})],
		},
	});

	assert.strictEqual(response.request.response, response);
	assert.strictEqual(response.body, 'replacement');
});

test('shortcut parse errors expose the replacement response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const promise = got('', {
		hooks: {
			afterResponse: [response => Object.assign(Object.create(response) as typeof response, {
				body: 'replacement',
				rawBody: new TextEncoder().encode('invalid JSON'),
			})],
		},
	});
	const response = await promise;
	const error = await rejects(promise.json(), ParseError);

	assert.strictEqual(error.response, response);
	assert.strictEqual(error.response.body, 'replacement');
});

test('contains Got options', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const options = {
		context: {
			foo: 'bar',
		},
	} as const;

	const error = await rejects(
		got(options),
		errorMatching(HTTPError, {message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v}),
	);
	assert.strictEqual(error?.response.statusCode, 404);
	assert.strictEqual(error?.options.context.foo, options.context.foo);
});

test('empty status message is overriden by the default one', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(400, '');
		response.end('body');
	});

	const error = await rejects(
		got(''),
		errorMatching(HTTPError, {message: /^Request failed with status code 400 \(Bad Request\): GET http:\/\/localhost:\d+\/$/v}),
	);
	assert.strictEqual(error?.response.statusCode, 400);
	assert.strictEqual(error?.response.statusMessage, http.STATUS_CODES[400]);
});

test('`http.request` error', async _t => {
	await assert.rejects(got('https://example.com', {
		request() {
			throw new TypeError('The header content contains invalid characters');
		},
	}), errorMatching(RequestError, {message: 'The header content contains invalid characters', code: 'ERR_GOT_REQUEST_ERROR'}));
});

test('`http.request` pipe error', async _t => {
	const message = 'snap!';

	await assert.rejects(got('https://example.com', {
		// @ts-expect-error Error tests
		request() {
			const proxy = new stream.PassThrough();

			const anyProxy = proxy as any;
			anyProxy.socket = {
				remoteAddress: '',
				prependOnceListener() {},
			};

			anyProxy.headers = {};

			anyProxy.abort = () => {};

			proxy.resume();
			proxy.read = () => {
				proxy.destroy(new Error(message));

				return null;
			};

			return proxy;
		},
		throwHttpErrors: false,
	}), errorMatching(RequestError, {message}));
});

test('`http.request` error through CacheableRequest', async _t => {
	await assert.rejects(got('https://example.com', {
		request() {
			throw new TypeError('The header content contains invalid characters');
		},
		cache: new Map(),
	}), errorMatching(RequestError, {message: 'The header content contains invalid characters'}));
});

test('returns a stream even if normalization fails', async _t => {
	const stream = got.stream('https://example.com', {
		// @ts-expect-error Testing purposes
		hooks: false,
	});

	await assert.rejects(getStream(stream), errorMatching(RequestError, {message: 'Expected value which is `Object`, received value of type `boolean`.'}));
});

test('returns a stream even if the input type is invalid', async _t => {
	// @ts-expect-error Testing purposes
	const stream = got.stream(123);

	await assert.rejects(getStream(stream), errorMatching(RequestError, {message: 'Option \'input\': Expected values which are `string`, `URL`, `Object`, or `undefined`. Received values of type `number`.'}));
});

test('normalization errors using convenience methods', async _t => {
	const url = 'undefined/https://example.com';

	{
		const error = await rejects(got(url).json());
		invalidUrl(error, url);
	}

	{
		const error = await rejects(got(url).text());
		invalidUrl(error, url);
	}

	{
		const error = await rejects(got(url).buffer());
		invalidUrl(error, url);
	}
});

test('errors can have request property', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const error = await rejects(got(''));

	assert.ok(error?.response);
	assert.ok(error?.request.downloadProgress);
});

test('promise does not hang on timeout on HTTP error', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.write('asdf');
	});

	await assert.rejects(got({
		timeout: {
			request: 100,
		},
	}), errorMatching(TimeoutError, {code: 'ETIMEDOUT'}));
});

test('no uncaught parse errors', async _t => {
	const {port, close} = await createRawHttpServer(socket => {
		socket.resume();
		void socket.end([
			'HTTP/1.1 404 Not Found',
			'transfer-encoding: chunked',
			'',
			'0',
			'',
			'',
		].join('\r\n'));
	});

	await assert.rejects(got.head(`http://localhost:${port}`), errorMatching(RequestError, {message: /^Parse Error/v}));

	await close();
});

test('no uncaught parse errors #2', async _t => {
	const {port, close} = await createRawHttpServer(socket => {
		socket.resume();
		socket.write([
			'HTTP/1.1 200 OK',
			'content-length: 1',
			'',
			'0a',
		].join('\r\n'));
	});

	await assert.rejects(got(`http://localhost:${port}`), errorMatching(RequestError, {message: /^Parse Error/v}));

	await close();
});

test.serial('no uncaught parse errors on fallback to utf8', withServer, async (_t, server, got) => {
	const originalDecode = TextDecoder.prototype.decode;
	let decodeCallCount = 0;

	server.get('/', (_request, response) => {
		response.end('{}');
	});

	try {
		await assert.rejects(got({
			responseType: 'json',
			parseJson() {
				TextDecoder.prototype.decode = function (): never {
					decodeCallCount++;
					if (decodeCallCount === 2) {
						TextDecoder.prototype.decode = originalDecode;
					}

					throw new RangeError('Injected fallback decode failure');
				};

				throw new SyntaxError('Injected parse failure');
			},
		}), errorMatching(RequestError, {code: 'ERR_BODY_PARSE_FAILURE'}));

		assert.strictEqual(decodeCallCount, 2);
	} finally {
		TextDecoder.prototype.decode = originalDecode;
	}
});

test('the old stacktrace is recovered', async _t => {
	const error = await rejects(got('https://example.com', {
		request() {
			throw new Error('foobar');
		},
	}));

	// The stacktrace should include the original error location (the custom request function)
	assert.strictEqual(error?.stack!.includes('at request'), true);

	// The stacktrace should include Got's error handling code
	assert.strictEqual(error?.stack!.includes('Request._beforeError') ?? error?.stack!.includes('_beforeError'), true);

	// Verify that Got's internal code paths are in the stack
	assert.strictEqual(error?.stack!.includes('Request.flush') ?? error?.stack!.includes('.flush'), true);
});

test('should wrap got cause', async _t => {
	const error = await rejects(got('https://github.com', {retry: {limit: 0}, timeout: {request: 1}}));
	const cause = error?.cause as TimeoutError;
	assert.strictEqual(error?.code, cause.code);
	assert.strictEqual(error?.message, cause.message);
});

test('should wrap non-got cause', async _t => {
	class SocksProxyAgent extends Agent {
		override createConnection(..._args: Parameters<InstanceType<typeof Agent>['createConnection']>): ReturnType<InstanceType<typeof Agent>['createConnection']> {
			throw new SocksClientError('oh no');
		}
	}
	class SocksClientError extends Error {}
	const error = await rejects(got('https://github.com', {retry: {limit: 0}, timeout: {read: 1}, agent: {https: new SocksProxyAgent()}}));
	const cause = error?.cause as Error;
	assert.strictEqual(error?.code, 'ERR_GOT_REQUEST_ERROR');
	assert.strictEqual(error?.message, cause.message);
	assert.strictEqual(error?.message, 'oh no');
	assert.ok(cause instanceof SocksClientError);
});

test.serial('custom stack trace', withServer, async (_t, _server, got) => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	const ErrorCaptureStackTrace = Error.captureStackTrace;

	const enable = () => {
		Error.captureStackTrace = (target: {stack: any}) => {
			target.stack = [
				'line 1',
				'line 2',
			];
		};
	};

	const disable = () => {
		Error.captureStackTrace = ErrorCaptureStackTrace;
	};

	// Node.js default behavior
	{
		const stream = got.stream('');
		stream.destroy(new Error('oh no'));

		const caught = await rejects(getStream(stream));
		assert.strictEqual(is(caught?.stack), 'string');
	}

	// Passing a custom error
	{
		enable();
		const error = new Error('oh no');
		disable();

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await rejects(getStream(stream));
		assert.strictEqual(is(caught?.stack), 'string');
	}

	// Custom global behavior
	{
		enable();
		const error = new Error('oh no');

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await rejects(getStream(stream));
		assert.strictEqual(is(caught?.stack), 'Array');

		disable();
	}

	// Passing a default error that needs some processing
	{
		const error = new Error('oh no');
		enable();

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await rejects(getStream(stream));
		assert.strictEqual(is(caught?.stack), 'Array');

		disable();
	}
});

test('RequestError accepts a partial cause with a stack and no message', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('response');
	});

	const {request} = await got('');
	const cause: Partial<Error> = {};
	Error.captureStackTrace(cause);

	const error = new RequestError('Request failed', cause, request);

	assert.strictEqual(error.message, 'Request failed');
	assert.strictEqual(error.cause, cause);
	assert.strictEqual(error.request, request);
	assert.strictEqual(error.stack.includes('Request failed'), true);
});

for (const message of [undefined, '', 'Original failure']) {
	test(`RequestError preserves cause stacks with message ${JSON.stringify(message)}`, _t => {
		const cause = {
			message,
			code: 'E_CUSTOM',
			stack: `Error${message ? `: ${message}` : ''}\n    at originalOperation (original.js:10:2)`,
		};
		const error = new RequestError('Wrapped failure', cause, got.defaults.options);

		assert.strictEqual(error.message, 'Wrapped failure');
		assert.strictEqual(error.code, 'E_CUSTOM');
		assert.strictEqual(error.cause, cause);
		assert.strictEqual(error.options, got.defaults.options);
		assert.strictEqual(error.stack.startsWith('RequestError: Wrapped failure\n'), true);
		assert.strictEqual(error.stack.endsWith('\n    at originalOperation (original.js:10:2)'), true);
	});
}

test('RequestError accepts a cause without a message or stack', _t => {
	const cause = {code: 'E_CUSTOM'};
	const error = new RequestError('Wrapped failure', cause, got.defaults.options);

	assert.strictEqual(error.message, 'Wrapped failure');
	assert.strictEqual(error.code, 'E_CUSTOM');
	assert.strictEqual(error.cause, cause);
	assert.strictEqual(error.stack.startsWith('RequestError: Wrapped failure\n'), true);
});

test('Web stream read failures are upload errors and do not trigger network retries', withServer, async (_t, server, got) => {
	const cause = Object.assign(new Error('Upload source failed'), {code: 'ECONNRESET'});
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			controller.enqueue(new TextEncoder().encode('first chunk'));
		},
	});
	let requests = 0;
	let retries = 0;
	server.put('/', request => {
		requests++;
		request.once('data', () => {
			controller.error(cause);
		});
	});

	const error = await rejects(got.put('', {
		body,
		retry: {limit: 1, calculateDelay: ({computedValue}) => Math.min(1, computedValue)},
		hooks: {
			beforeRetry: [() => {
				retries++;
			}],
		},
	}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(requests, 1);
	assert.strictEqual(retries, 0);
	assert.strictEqual(body.locked, false);
});

for (const cause of [new Error('Source pull failed'), 'Source pull failed']) {
	test(`Web stream pull failures preserve ${typeof cause} messages`, withServer, async (_t, _server, got) => {
		const body = new ReadableStream({
			pull() {
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- Web stream sources can reject reads with any value.
				throw cause;
			},
		});

		const error = await rejects(got.post('', {body}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: 'Source pull failed'}));

		if (cause instanceof Error) {
			assert.strictEqual(error.cause, cause);
		} else {
			assert.strictEqual((error.cause as Error).message, cause);
		}

		assert.strictEqual(body.locked, false);
	});
}

test('Web stream read failures are upload errors in the streaming API', withServer, async (_t, _server, got) => {
	const cause = new Error('Source failed');
	const body = new ReadableStream({
		start(controller) {
			controller.error(cause);
		},
	});

	const error = await rejects(getStream(got.stream.post('', {body})), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(body.locked, false);
});

for (const chunks of [[], ['first', 'second']]) {
	test(`Web uploads release the reader after ${chunks.length} successful chunks`, withServer, async (_t, server, got) => {
		server.post('/', async (request, response) => {
			response.end(await getStream(request));
		});

		const body = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(new TextEncoder().encode(chunk));
				}

				controller.close();
			},
		});

		assert.strictEqual(await got.post('', {body}).text(), chunks.join(''));
		assert.strictEqual(body.locked, false);
	});
}

test('network errors during Web uploads retain their request error classification', withServer, async (_t, server, got) => {
	server.put('/', request => {
		request.once('data', () => {
			request.socket.destroy();
		});
	});

	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('first chunk'));
		},
		cancel() {
			cancelled = true;
		},
	});
	const error = await rejects(got.put('', {body, retry: {limit: 0}}), errorMatching(RequestError, {code: 'ECONNRESET'}));

	assert.strictEqual(error instanceof UploadError, false);
	assert.strictEqual(cancelled, true);
	assert.strictEqual(body.locked, false);
});

test('Node bodies supplied by beforeRequest report source failures as upload errors', withServer, async (_t, server, got) => {
	const cause = new Error('Replacement body failed');
	const body = new stream.PassThrough();
	let sourceErrors = 0;
	body.once('error', () => {
		sourceErrors++;
	});
	body.write('first chunk');

	server.post('/', request => {
		request.once('data', () => {
			body.destroy(cause);
		});
	});

	const error = await rejects(got.post('', {
		retry: {limit: 0},
		timeout: {request: 10_000},
		hooks: {
			beforeRequest: [options => {
				options.body = body;
			}],
		},
	}), errorMatching(UploadError, {code: 'ERR_UPLOAD', message: cause.message}));

	assert.strictEqual(error.cause, cause);
	assert.strictEqual(sourceErrors, 1);
});

test('HTTPError binds the response supplied to its constructor', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const response = await got('');
	const replacement = Object.assign(Object.create(response) as typeof response, {statusCode: 409, body: 'replacement'});
	const error = new HTTPError(replacement);

	assert.strictEqual(error.response.statusCode, 409);
	assert.strictEqual(error.response.body, 'replacement');
	assert.strictEqual(error.response, replacement);
	assert.strictEqual(error.request, response.request);
	assert.strictEqual(response.request.response, response);
});

test('ParseError binds its supplied response without exposing it during enumeration', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const response = await got('');
	const replacement = Object.assign(Object.create(response) as typeof response, {body: 'invalid JSON'});
	const cause = new SyntaxError('Parsing failed');
	const error = new ParseError(cause, replacement);

	assert.strictEqual(error.response, replacement);
	assert.strictEqual(error.response.body, 'invalid JSON');
	assert.strictEqual(error.cause, cause);
	assert.strictEqual(error.request, response.request);
	assert.strictEqual(response.request.response, response);
	assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, 'response'), false);
});

for (const throwHttpErrors of [true, false]) {
	test(`hook HTTP errors retain their supplied response with throwHttpErrors ${throwHttpErrors}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('original');
		});

		const body = 'Application conflict';
		const promise = got('', {
			throwHttpErrors,
			retry: {limit: 0},
			hooks: {
				afterResponse: [response => {
					const replacement = Object.assign(Object.create(response) as typeof response, {
						statusCode: 409,
						body,
						rawBody: new TextEncoder().encode(body),
					});
					throw new HTTPError(replacement);
				}],
			},
		});
		const response = throwHttpErrors
			? (await rejects(promise, HTTPError)).response
			: await promise;

		assert.strictEqual(response.statusCode, 409);
		assert.strictEqual(response.body, body);
		if (!throwHttpErrors) {
			assert.strictEqual(await promise.text(), body);
		}
	});
}

test('hook parse errors retain their supplied response and cause', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const cause = new SyntaxError('Application parsing failed');
	let replacement: Response | undefined;
	const error = await rejects(got('', {
		hooks: {
			afterResponse: [response => {
				const updatedResponse = Object.assign(Object.create(response) as typeof response, {body: 'invalid JSON'});
				replacement = updatedResponse;
				throw new ParseError(cause, updatedResponse);
			}],
		},
	}), ParseError);

	assert.strictEqual(replacement, error.response);
	assert.strictEqual(error.response.body, 'invalid JSON');
	assert.strictEqual(error.cause, cause);
});

for (const thrown of [null, undefined, 'a string', 42]) {
	test(`RequestError keeps a cause of ${JSON.stringify(thrown) ?? 'undefined'} and reports a message`, _t => {
		const error = new RequestError('Wrapped failure', thrown as never, new Options());

		assert.strictEqual(error.code, 'ERR_GOT_REQUEST_ERROR');
		assert.strictEqual(error.input, undefined);
		assert.strictEqual(error.cause, thrown);
		assert.strictEqual(error.message, 'Wrapped failure');
	});
}

test('RequestError copies the code and input of an object cause', _t => {
	const cause = {code: 'E_CUSTOM', input: 'payload', message: 'custom'};
	const error = new RequestError('Wrapped failure', cause, new Options());

	assert.strictEqual(error.code, 'E_CUSTOM');
	assert.strictEqual(error.input, 'payload');
	assert.strictEqual(error.cause, cause);
});

test('ParseError reports a thrown value without a message and keeps it as the cause', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('{}');
	});

	const thrown = {code: 'E_CUSTOM'};
	const error = await rejects(got('', {
		parseJson() {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw thrown;
		},
	}).json(), ParseError);

	assert.strictEqual(error.message.startsWith('Non-error object thrown in '), true);
	assert.strictEqual(error.code, 'ERR_BODY_PARSE_FAILURE');
	assert.strictEqual(error.cause, thrown);
});

// A subclass sets `name` after `super()` returns, so the stack header has to be built on
// first read. Otherwise every subclass is reported as a plain `RequestError` in logs.
for (const [name, create, expectedName] of [
	['ParseError', () => new ParseError(new Error('inner'), {request: {options: {url: 'http://x/'}}} as never), 'ParseError'],
	['TimeoutError', () => new TimeoutError({message: 'timed out', event: 'request'} as never, {start: 0, error: 0, phases: {total: 0}}, undefined!), 'TimeoutError'],
	['ReadError', () => new ReadError(new Error('inner'), {request: {options: {url: 'http://x/'}}} as never), 'ReadError'],
	['UploadError', () => new UploadError(new Error('inner'), {request: {options: {url: 'http://x/'}}} as never), 'UploadError'],
	['CacheError', () => new CacheError(new Error('inner'), {request: {options: {url: 'http://x/'}}} as never), 'CacheError'],
	['RequestError', () => new RequestError('plain', new Error('inner'), {options: {url: 'http://x/'}} as never), 'RequestError'],
] as Array<[string, () => Error, string]>) {
	test(`a ${name} reports its own name in the stack`, _t => {
		const error = create();

		assert.strictEqual(error.name, expectedName);
		assert.strictEqual(String(error.stack).split('\n', 1)[0], `${expectedName}: ${error.message}`);
	});
}

// The header is rebuilt on access, so an empty message must not leave the old one in the frames.
test('an error with an empty message reports one header line', _t => {
	const cause = new Error('inner');
	const error = new RequestError('', cause, got.defaults.options);
	const lines = error.stack.split('\n');

	assert.strictEqual(lines[0], 'RequestError: ');
	assert.strictEqual(lines[1]!.startsWith('    at '), true);
	assert.strictEqual(lines.filter(line => line.startsWith('RequestError')).length, 1);
	assert.strictEqual(error.stack.includes(cause.stack!.split('\n', 2)[1] ?? 'at '), true);
});

// An assigned stack is honoured, the way `Error` does.
test('an assigned error stack is kept', _t => {
	const error = new ReadError(new Error('inner'), {options: got.defaults.options} as never);

	error.stack = 'ASSIGNED';

	assert.strictEqual(error.stack, 'ASSIGNED');
});

// The cause's stack carries its own `name: message` header, which the rebuild has to drop the
// same way it drops this error's. An empty cause message is where that is easiest to miss.
test('an empty cause message does not leave its header in the frames', _t => {
	const cause = new Error('inner');

	cause.message = '';
	cause.name = 'CustomError';
	cause.stack = 'CustomError\n    at causeFn (cause.js:1:1)';
	const error = new RequestError('outer message', cause, got.defaults.options);
	const lines = error.stack.split('\n');

	assert.strictEqual(lines[0], 'RequestError: outer message');
	assert.deepStrictEqual(lines.slice(1).filter(line => !line.startsWith('    at ')), []);
});

// A `JSON.parse` failure quotes the offending source, so the message spans several lines.
// None of them may reappear among the frames.
test('a multi-line message is not repeated in the stack frames', _t => {
	const message = 'Unexpected token o\n  "b": oops\n}';
	const cause = new Error(message);
	const error = new RequestError(`${message} in "https://example.com/"`, cause, got.defaults.options);
	const lines = error.stack.split('\n');

	assert.strictEqual(lines[0], 'RequestError: Unexpected token o');
	assert.strictEqual(lines[1], '  "b": oops');
	assert.strictEqual(lines[2], '} in "https://example.com/"');
	assert.strictEqual(lines[3]!.startsWith('    at '), true, `Expected a frame, got ${lines[3]}`);
	assert.strictEqual(lines.filter(line => line.includes('"b": oops')).length, 1);
});

// `error.response` is typed with the request's `responseType`, so the body must be parsed
// the same way a successful response would be.
for (const [name, responseType, expected] of [
	['text', 'text', '{"redirect":"body"}'],
	['json', 'json', {redirect: 'body'}],
	['buffer', 'buffer', new TextEncoder().encode('{"redirect":"body"}')],
] as Array<[string, 'text' | 'json' | 'buffer', unknown]>) {
	test(`a MaxRedirectsError carries a ${name} response body`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(302, {location: '/next'});
			response.end('{"redirect":"body"}');
		});

		const error = await rejects(got('', {
			responseType,
			maxRedirects: 0,
			retry: {
				limit: 0,
			},
		}));

		assert.deepStrictEqual(error?.response?.body, expected);
	});
}
