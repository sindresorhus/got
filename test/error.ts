import {promisify} from 'util';
import http = require('http');
import stream = require('stream');
import test from 'ava';
import got, {RequestError, HTTPError} from '../source';
import withServer from './helpers/with-server';

const pStreamPipeline = promisify(stream.pipeline);

test('properties', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const url = new URL(server.url);

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.truthy(error);
	t.truthy(error.response);
	t.truthy(error.options);
	t.false({}.propertyIsEnumerable.call(error, 'options'));
	t.false({}.propertyIsEnumerable.call(error, 'response'));
	// This fails because of TS 3.7.2 useDefineForClassFields
	// Class fields will always be initialized, even though they are undefined
	// A test to check for undefined is in place below
	// t.false({}.hasOwnProperty.call(error, 'code'));
	t.is(error.code, undefined);
	t.is(error.message, 'Response code 404 (Not Found)');
	t.deepEqual(error.options.url, url);
	t.is(error.response.headers.connection, 'close');
	t.is(error.response.body, 'not');
});

test('catches dns errors', async t => {
	const error = await t.throwsAsync<RequestError>(got('http://doesntexist', {retry: 0}));
	t.truthy(error);
	t.regex(error.message, /ENOTFOUND/);
	t.is(error.options.url.host, 'doesntexist');
	t.is(error.options.method, 'GET');
});

test('`options.body` form error message', async t => {
	// @ts-ignore Error tests
	await t.throwsAsync(got.post('https://example.com', {body: Buffer.from('test'), form: ''}), {
		message: 'The `body`, `json` and `form` options are mutually exclusive'
	});
});

test('no plain object restriction on json body', withServer, async (t, server, got) => {
	server.post('/body', async (request, response) => {
		await pStreamPipeline(request, response);
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

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 400);
	t.is(error.response.statusMessage, 'Bad Request');
});

test('custom status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.statusMessage = 'Something Exploded';
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 400);
	t.is(error.response.statusMessage, 'Something Exploded');
});

test('custom body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 404);
	t.is(error.response.body, 'not');
});

test('contains Got options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const options: {agent: false} = {
		agent: false
	};

	const error = await t.throwsAsync<RequestError>(got(options));
	t.is(error.options.agent, options.agent);
});

test('empty status message is overriden by the default one', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(400, '');
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 400);
	t.is(error.response.statusMessage, http.STATUS_CODES[400]);
});

test('`http.request` error', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new TypeError('The header content contains invalid characters');
		}
	}), {
		instanceOf: got.RequestError,
		message: 'The header content contains invalid characters'
	});
});

test('`http.request` pipe error', async t => {
	const message = 'snap!';

	// @ts-ignore Error tests
	await t.throwsAsync(got('https://example.com', {
		// @ts-ignore Error tests
		request: () => {
			const proxy = new stream.PassThrough();

			const anyProxy = proxy as any;
			anyProxy.socket = {
				remoteAddress: '',
				prependOnceListener: () => {}
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
		throwHttpErrors: false
	}), {
		instanceOf: got.RequestError,
		message
	});
});

test('`http.request` error through CacheableRequest', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new TypeError('The header content contains invalid characters');
		},
		cache: new Map()
	}), {
		instanceOf: got.RequestError,
		message: 'The header content contains invalid characters'
	});
});

test('errors are thrown directly when options.stream is true', t => {
	t.throws(() => {
		// @ts-ignore Error tests
		got('https://example.com', {isStream: true, hooks: false});
	}, {
		message: 'Expected value which is `predicate returns truthy for any value`, received value of type `Array`.'
	});
});

test('normalization errors using convenience methods', async t => {
	const url = 'undefined/https://example.com';
	await t.throwsAsync(got(url).json().text().buffer(), {message: `Invalid URL: ${url}`});
});

// Fails randomly on Node 10:
// Blocked by https://github.com/istanbuljs/nyc/issues/619
// eslint-disable-next-line ava/no-skip-test
test.skip('the old stacktrace is recovered', async t => {
	const error = await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new Error('foobar');
		}
	}));

	t.true(error.stack!.includes('at Object.request'));

	// The first `at get` points to where the error was wrapped,
	// the second `at get` points to the real cause.
	t.not(error.stack!.indexOf('at get'), error.stack!.lastIndexOf('at get'));
});
