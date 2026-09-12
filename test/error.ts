import {Buffer} from 'node:buffer';
import http from 'node:http';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import {Agent} from 'node:https';
import test from 'ava';
import getStream from 'get-stream';
import is from '@sindresorhus/is';
import got, {
	RequestError, HTTPError, TimeoutError, ParseError, UploadError, type Response,
} from '../source/index.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';
import invalidUrl from './helpers/invalid-url.js';

test('properties', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const url = new URL(server.url);

	const error = (await t.throwsAsync<HTTPError<string>>(got('')));
	t.truthy(error);
	t.truthy(error.response);
	t.truthy(error.options);
	t.true(Object.prototype.propertyIsEnumerable.call(error, 'options'));
	t.false(Object.prototype.propertyIsEnumerable.call(error, 'response'));
	t.is(error.code, 'ERR_NON_2XX_3XX_RESPONSE');
	t.regex(error.message, /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v);
	t.deepEqual(error.options.url, url);
	t.is(error.response.headers.connection, 'keep-alive');
	// Assert is used for type checking
	t.assert(error.response.body === 'not');
});

test('catches dns errors', async t => {
	const error = (await t.throwsAsync<RequestError<undefined>>(got('http://doesntexist', {retry: {limit: 0}})));
	t.truthy(error);
	t.regex(error.message, /ENOTFOUND|EAI_AGAIN/v);
	t.is((error.options.url as URL).host, 'doesntexist');
	t.is(error.options.method, 'GET');
	t.true(['ENOTFOUND', 'EAI_AGAIN'].includes(error.code));
});

test('`options.body` form error message', async t => {
	await t.throwsAsync(
		got.post('https://example.com', {body: Buffer.from('test'), form: '' as any}),
		{
			instanceOf: RequestError,
			message: 'Option \'form\': Expected values which are `plain object` or `undefined`. Received values of type `string`.',
		},
		// {message: 'The `body`, `json` and `form` options are mutually exclusive'}
	);
});

test('no plain object restriction on json body', withServer, async (t, server, got) => {
	server.post('/body', async (request, response) => {
		await streamPipeline(request, response);
	});

	class CustomObject {
		a = 123;
	}

	const body = await got.post('body', {json: new CustomObject()}).json();

	t.deepEqual(body, {a: 123});
});

test('default status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(
		got(''),
		{
			instanceOf: HTTPError,
			message: /^Request failed with status code 400 \(Bad Request\): GET http:\/\/localhost:\d+\/$/v,
		},
	);
	t.is(error?.response.statusCode, 400);
	t.is(error?.response.statusMessage, 'Bad Request');
});

test('custom status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.statusMessage = 'Something Exploded';
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(
		got(''),
		{
			instanceOf: HTTPError,
			message: /^Request failed with status code 400 \(Something Exploded\): GET http:\/\/localhost:\d+\/$/v,
		},
	);
	t.is(error?.response.statusCode, 400);
	t.is(error?.response.statusMessage, 'Something Exploded');
});

test('credentials are stripped from HTTPError message URL', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(
		got('', {username: 'user', password: 'secret'}),
		{instanceOf: HTTPError},
	);
	t.false(error?.message.includes('user'));
	t.false(error?.message.includes('secret'));
	t.regex(error?.message ?? '', /^Request failed with status code 400 \(Bad Request\): GET http:\/\/localhost:\d+\/$/v);
});

test('custom body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync<HTTPError>(
		got(''),
		{
			instanceOf: HTTPError,
			message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v,
		},
	);
	t.is(error?.response.statusCode, 404);
	// Typecheck for default `any` type
	t.assert(error?.response.body === 'not');
});

test('custom json body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.header('content-type', 'application/json');
		response.end(JSON.stringify({
			message: 'not found',
		}));
	});

	const error = await t.throwsAsync<HTTPError<{message: string}>>(
		got('', {responseType: 'json'}),
		{
			instanceOf: HTTPError,
			message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v,
		},
	);
	t.is(error?.response.statusCode, 404);
	// Assert is used for body typecheck
	t.assert(error?.response.body.message === 'not found');
});

test('HTTP errors preserve the replacement response returned by a hook', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const error = await t.throwsAsync<HTTPError>(got('', {
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => Object.assign(Object.create(response) as typeof response, {statusCode: 400, body: 'application failure'})],
		},
	}), {instanceOf: HTTPError});

	t.is(error.response.statusCode, 400);
	t.is(error.response.body, 'application failure');
});

for (const resolveBodyOnly of [false, true]) {
	test(`suppressed HTTP errors preserve replacement responses with resolveBodyOnly ${resolveBodyOnly}`, withServer, async (t, server, got) => {
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
			t.is(result, 'application failure');
		} else {
			const response = result as Response;
			t.is(response.statusCode, 400);
			t.is(response.body, 'application failure');
			t.false(response.ok);
		}
	});
}

test('replacement response status codes control retries', withServer, async (t, server, got) => {
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

	t.is(requests, 2);
	t.is(response.body, 'success');
	t.is(response.retryCount, 1);
});

test('successful replacement responses remain attached to their request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const response = await got('', {
		hooks: {
			afterResponse: [response => Object.assign(Object.create(response) as typeof response, {body: 'replacement'})],
		},
	});

	t.is(response.request.response, response);
	t.is(response.body, 'replacement');
});

test('shortcut parse errors expose the replacement response', withServer, async (t, server, got) => {
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
	const error = await t.throwsAsync<ParseError>(promise.json(), {instanceOf: ParseError});

	t.is(error.response, response);
	t.is(error.response.body, 'replacement');
});

test('contains Got options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const options = {
		context: {
			foo: 'bar',
		},
	} as const;

	const error = await t.throwsAsync<HTTPError>(
		got(options),
		{
			instanceOf: HTTPError,
			message: /^Request failed with status code 404 \(Not Found\): GET http:\/\/localhost:\d+\/$/v,
		},
	);
	t.is(error?.response.statusCode, 404);
	t.is(error?.options.context.foo, options.context.foo);
});

test('empty status message is overriden by the default one', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(400, '');
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(
		got(''),
		{
			instanceOf: HTTPError,
			message: /^Request failed with status code 400 \(Bad Request\): GET http:\/\/localhost:\d+\/$/v,
		},
	);
	t.is(error?.response.statusCode, 400);
	t.is(error?.response.statusMessage, http.STATUS_CODES[400]);
});

test('`http.request` error', async t => {
	await t.throwsAsync(got('https://example.com', {
		request() {
			throw new TypeError('The header content contains invalid characters');
		},
	}), {
		instanceOf: RequestError,
		message: 'The header content contains invalid characters',
		code: 'ERR_GOT_REQUEST_ERROR',
	});
});

test('`http.request` pipe error', async t => {
	const message = 'snap!';

	await t.throwsAsync(got('https://example.com', {
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
	}), {
		instanceOf: RequestError,
		message,
	});
});

test('`http.request` error through CacheableRequest', async t => {
	await t.throwsAsync(got('https://example.com', {
		request() {
			throw new TypeError('The header content contains invalid characters');
		},
		cache: new Map(),
	}), {
		instanceOf: RequestError,
		message: 'The header content contains invalid characters',
	});
});

test('returns a stream even if normalization fails', async t => {
	const stream = got.stream('https://example.com', {
		// @ts-expect-error Testing purposes
		hooks: false,
	});

	await t.throwsAsync(getStream(stream), {
		instanceOf: RequestError,
		message: 'Expected value which is `Object`, received value of type `boolean`.',
	});
});

test('returns a stream even if the input type is invalid', async t => {
	// @ts-expect-error Testing purposes
	const stream = got.stream(123);

	await t.throwsAsync(getStream(stream), {
		instanceOf: RequestError,
		message: 'Option \'input\': Expected values which are `string`, `URL`, `Object`, or `undefined`. Received values of type `number`.',
	});
});

test('normalization errors using convenience methods', async t => {
	const url = 'undefined/https://example.com';

	{
		const error = await t.throwsAsync(got(url).json());
		invalidUrl(t, error, url);
	}

	{
		const error = await t.throwsAsync(got(url).text());
		invalidUrl(t, error, url);
	}

	{
		const error = await t.throwsAsync(got(url).buffer());
		invalidUrl(t, error, url);
	}
});

test('errors can have request property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const error = await t.throwsAsync<HTTPError>(got(''));

	t.truthy(error?.response);
	t.truthy(error?.request.downloadProgress);
});

test('promise does not hang on timeout on HTTP error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.write('asdf');
	});

	await t.throwsAsync(got({
		timeout: {
			request: 100,
		},
	}), {
		instanceOf: TimeoutError,
		code: 'ETIMEDOUT',
	});
});

test('no uncaught parse errors', async t => {
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

	await t.throwsAsync(got.head(`http://localhost:${port}`), {
		instanceOf: RequestError,
		message: /^Parse Error/v,
	});

	await close();
});

test('no uncaught parse errors #2', async t => {
	const {port, close} = await createRawHttpServer(socket => {
		socket.resume();
		socket.write([
			'HTTP/1.1 200 OK',
			'content-length: 1',
			'',
			'0a',
		].join('\r\n'));
	});

	await t.throwsAsync(got(`http://localhost:${port}`), {
		instanceOf: RequestError,
		message: /^Parse Error/v,
	});

	await close();
});

test.serial('no uncaught parse errors on fallback to utf8', withServer, async (t, server, got) => {
	const originalDecode = globalThis.TextDecoder.prototype.decode;
	let decodeCallCount = 0;

	server.get('/', (_request, response) => {
		response.end('{}');
	});

	try {
		await t.throwsAsync(got({
			responseType: 'json',
			parseJson() {
				globalThis.TextDecoder.prototype.decode = function (): never {
					decodeCallCount++;
					if (decodeCallCount === 2) {
						globalThis.TextDecoder.prototype.decode = originalDecode;
					}

					throw new RangeError('Injected fallback decode failure');
				};

				throw new SyntaxError('Injected parse failure');
			},
		}), {
			instanceOf: RequestError,
			code: 'ERR_BODY_PARSE_FAILURE',
		});

		t.is(decodeCallCount, 2);
	} finally {
		globalThis.TextDecoder.prototype.decode = originalDecode;
	}
});

test('the old stacktrace is recovered', async t => {
	const error = await t.throwsAsync(got('https://example.com', {
		request() {
			throw new Error('foobar');
		},
	}));

	// The stacktrace should include the original error location (the custom request function)
	t.true(error?.stack!.includes('at request'));

	// The stacktrace should include Got's error handling code
	t.true(error?.stack!.includes('Request._beforeError') ?? error?.stack!.includes('_beforeError'));

	// Verify that Got's internal code paths are in the stack
	t.true(error?.stack!.includes('Request.flush') ?? error?.stack!.includes('.flush'));
});

test('should wrap got cause', async t => {
	const error = await t.throwsAsync<RequestError>(got('https://github.com', {retry: {limit: 0}, timeout: {request: 1}}));
	const cause = error?.cause as TimeoutError;
	t.is(error?.code, cause.code);
	t.is(error?.message, cause.message);
});

test('should wrap non-got cause', async t => {
	class SocksProxyAgent extends Agent {
		override createConnection(..._args: Parameters<InstanceType<typeof Agent>['createConnection']>): ReturnType<InstanceType<typeof Agent>['createConnection']> {
			throw new SocksClientError('oh no');
		}
	}
	class SocksClientError extends Error {}
	const error = await t.throwsAsync<RequestError>(got('https://github.com', {retry: {limit: 0}, timeout: {read: 1}, agent: {https: new SocksProxyAgent()}}));
	const cause = error?.cause as Error;
	t.is(error?.code, 'ERR_GOT_REQUEST_ERROR');
	t.is(error?.message, cause.message);
	t.is(error?.message, 'oh no');
	t.assert(cause instanceof SocksClientError);
});

test.serial('custom stack trace', withServer, async (t, _server, got) => {
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

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught?.stack), 'string');
	}

	// Passing a custom error
	{
		enable();
		const error = new Error('oh no');
		disable();

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught?.stack), 'string');
	}

	// Custom global behavior
	{
		enable();
		const error = new Error('oh no');

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught?.stack), 'Array');

		disable();
	}

	// Passing a default error that needs some processing
	{
		const error = new Error('oh no');
		enable();

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught?.stack), 'Array');

		disable();
	}
});

test('RequestError accepts a partial cause with a stack and no message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('response');
	});

	const {request} = await got('');
	const cause: Partial<Error> = {};
	Error.captureStackTrace(cause);

	const error = new RequestError('Request failed', cause, request);

	t.is(error.message, 'Request failed');
	t.is(error.cause, cause);
	t.is(error.request, request);
	t.true(error.stack.includes('Request failed'));
});

for (const message of [undefined, '', 'Original failure']) {
	test(`RequestError preserves cause stacks with message ${JSON.stringify(message)}`, t => {
		const cause = {
			message,
			code: 'E_CUSTOM',
			stack: `Error${message ? `: ${message}` : ''}\n    at originalOperation (original.js:10:2)`,
		};
		const error = new RequestError('Wrapped failure', cause, got.defaults.options);

		t.is(error.message, 'Wrapped failure');
		t.is(error.code, 'E_CUSTOM');
		t.is(error.cause, cause);
		t.is(error.options, got.defaults.options);
		t.true(error.stack.startsWith('RequestError: Wrapped failure\n'));
		t.true(error.stack.endsWith('\n    at originalOperation (original.js:10:2)'));
	});
}

test('RequestError accepts a cause without a message or stack', t => {
	const cause = {code: 'E_CUSTOM'};
	const error = new RequestError('Wrapped failure', cause, got.defaults.options);

	t.is(error.message, 'Wrapped failure');
	t.is(error.code, 'E_CUSTOM');
	t.is(error.cause, cause);
	t.true(error.stack.startsWith('RequestError: Wrapped failure\n'));
});

test('Web stream read failures are upload errors and do not trigger network retries', withServer, async (t, server, got) => {
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

	const error = await t.throwsAsync<UploadError>(got.put('', {
		body,
		retry: {limit: 1, calculateDelay: ({computedValue}) => Math.min(1, computedValue)},
		hooks: {
			beforeRetry: [() => {
				retries++;
			}],
		},
	}), {instanceOf: UploadError, code: 'ERR_UPLOAD', message: cause.message});

	t.is(error.cause, cause);
	t.is(requests, 1);
	t.is(retries, 0);
	t.false(body.locked);
});

for (const cause of [new Error('Source pull failed'), 'Source pull failed']) {
	test(`Web stream pull failures preserve ${typeof cause} messages`, withServer, async (t, _server, got) => {
		const body = new ReadableStream({
			pull() {
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- Web stream sources can reject reads with any value.
				throw cause;
			},
		});

		const error = await t.throwsAsync<UploadError>(got.post('', {body}), {
			instanceOf: UploadError,
			code: 'ERR_UPLOAD',
			message: 'Source pull failed',
		});

		if (cause instanceof Error) {
			t.is(error.cause, cause);
		} else {
			t.is((error.cause as Error).message, cause);
		}

		t.false(body.locked);
	});
}

test('Web stream read failures are upload errors in the streaming API', withServer, async (t, _server, got) => {
	const cause = new Error('Source failed');
	const body = new ReadableStream({
		start(controller) {
			controller.error(cause);
		},
	});

	const error = await t.throwsAsync<UploadError>(getStream(got.stream.post('', {body})), {
		instanceOf: UploadError,
		code: 'ERR_UPLOAD',
		message: cause.message,
	});

	t.is(error.cause, cause);
	t.false(body.locked);
});

for (const chunks of [[], ['first', 'second']]) {
	test(`Web uploads release the reader after ${chunks.length} successful chunks`, withServer, async (t, server, got) => {
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

		t.is(await got.post('', {body}).text(), chunks.join(''));
		t.false(body.locked);
	});
}

test('network errors during Web uploads retain their request error classification', withServer, async (t, server, got) => {
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
	const error = await t.throwsAsync<RequestError>(got.put('', {body, retry: {limit: 0}}), {
		instanceOf: RequestError,
		code: 'ECONNRESET',
	});

	t.false(error instanceof UploadError);
	t.true(cancelled);
	t.false(body.locked);
});

test('Node bodies supplied by beforeRequest report source failures as upload errors', withServer, async (t, server, got) => {
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

	const error = await t.throwsAsync<UploadError>(got.post('', {
		retry: {limit: 0},
		timeout: {request: 250},
		hooks: {
			beforeRequest: [options => {
				options.body = body;
			}],
		},
	}), {instanceOf: UploadError, code: 'ERR_UPLOAD', message: cause.message});

	t.is(error.cause, cause);
	t.is(sourceErrors, 1);
});

test('HTTPError binds the response supplied to its constructor', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const response = await got('');
	const replacement = Object.assign(Object.create(response) as typeof response, {statusCode: 409, body: 'replacement'});
	const error = new HTTPError(replacement);

	t.is(error.response.statusCode, 409);
	t.is(error.response.body, 'replacement');
	t.is(error.response, replacement);
	t.is(error.request, response.request);
	t.is(response.request.response, response);
});

test('ParseError binds its supplied response without exposing it during enumeration', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const response = await got('');
	const replacement = Object.assign(Object.create(response) as typeof response, {body: 'invalid JSON'});
	const cause = new SyntaxError('Parsing failed');
	const error = new ParseError(cause, replacement);

	t.is(error.response, replacement);
	t.is(error.response.body, 'invalid JSON');
	t.is(error.cause, cause);
	t.is(error.request, response.request);
	t.is(response.request.response, response);
	t.false(Object.prototype.propertyIsEnumerable.call(error, 'response'));
});

for (const throwHttpErrors of [true, false]) {
	test(`hook HTTP errors retain their supplied response with throwHttpErrors ${throwHttpErrors}`, withServer, async (t, server, got) => {
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
			? (await t.throwsAsync<HTTPError>(promise, {instanceOf: HTTPError})).response
			: await promise;

		t.is(response.statusCode, 409);
		t.is(response.body, body);
		if (!throwHttpErrors) {
			t.is(await promise.text(), body);
		}
	});
}

test('hook parse errors retain their supplied response and cause', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('original');
	});

	const cause = new SyntaxError('Application parsing failed');
	let replacement: Response | undefined;
	const error = await t.throwsAsync<ParseError>(got('', {
		hooks: {
			afterResponse: [response => {
				const updatedResponse = Object.assign(Object.create(response) as typeof response, {body: 'invalid JSON'});
				replacement = updatedResponse;
				throw new ParseError(cause, updatedResponse);
			}],
		},
	}), {instanceOf: ParseError});

	t.is(replacement, error.response);
	t.is(error.response.body, 'invalid JSON');
	t.is(error.cause, cause);
});
