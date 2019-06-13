import {URL} from 'url';
import http from 'http';
import test from 'ava';
import proxyquire from 'proxyquire';
import got from '../source';
import withServer from './helpers/with-server';

test('properties', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const url = new URL(server.url);

	const error = await t.throwsAsync(got('')) as any;
	t.truthy(error);
	// @ts-ignore
	t.truthy(error.response);
	t.truthy(error.options);
	t.false({}.propertyIsEnumerable.call(error, 'options'));
	t.false({}.propertyIsEnumerable.call(error, 'response'));
	t.false({}.hasOwnProperty.call(error, 'code'));
	t.is(error.message, 'Response code 404 (Not Found)');
	t.is(error.options.host, `${url.hostname}:${url.port}`);
	t.is(error.options.method, 'GET');
	t.is(error.options.protocol, 'http:');
	t.is(error.options.url, error.options.requestUrl);
	t.is(error.response.headers.connection, 'close');
	t.is(error.response.body, 'not');
});

test('catches dns errors', async t => {
	const error = await t.throwsAsync(got('http://doesntexist', {retry: 0})) as any;
	t.truthy(error);
	t.regex(error.message, /getaddrinfo ENOTFOUND/);
	t.is(error.options.host, 'doesntexist');
	t.is(error.options.method, 'GET');
});

test('`options.body` form error message', async t => {
	// @ts-ignore Manual tests
	await t.throwsAsync(got.post('https://example.com', {body: Buffer.from('test'), form: ''}), {
		message: 'The `body` option cannot be used with the `json` option or `form` option'
	});
});

test('no plain object restriction on json body', withServer, async (t, server, got) => {
	server.post('/body', async (request, response) => {
		request.pipe(response);
	});

	function CustomObject() {
		this.a = 123;
	}

	const body = await got.post('body', {json: new CustomObject()}).json();

	t.deepEqual(body, {a: 123});
});

test('default status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	const error = await t.throwsAsync(got(''));
	// @ts-ignore
	t.is(error.response.statusCode, 400);
	// @ts-ignore
	t.is(error.response.statusMessage, 'Bad Request');
});

test('custom status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.statusMessage = 'Something Exploded';
		response.end('body');
	});

	const error = await t.throwsAsync(got(''));
	// @ts-ignore
	t.is(error.response.statusCode, 400);
	// @ts-ignore
	t.is(error.response.statusMessage, 'Something Exploded');
});

test('custom body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync(got(''));
	// @ts-ignore
	t.is(error.response.statusCode, 404);
	// @ts-ignore
	t.is(error.response.body, 'not');
});

test('contains Got options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const options = {
		auth: 'foo:bar'
	};

	const error = await t.throwsAsync(got(options));
	// @ts-ignore
	t.is(error.options.auth, options.auth);
});

test('empty status message is overriden by the default one', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(400, '');
		response.end('body');
	});

	const error = await t.throwsAsync(got(''));
	// @ts-ignore
	t.is(error.response.statusCode, 400);
	// @ts-ignore
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

	await t.throwsAsync(got('https://example.com', {
		// @ts-ignore Manual tests
		request: () => {
			return {
				end: () => {
					throw new Error(message);
				},
				on: () => {},
				once: () => {},
				emit: () => {}
			};
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

test('catches error in mimicResponse', withServer, async (t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const mimicResponse = () => {
		throw new Error('Error in mimic-response');
	};

	mimicResponse['@global'] = true;

	const proxiedGot = proxyquire('../source', {
		'mimic-response': mimicResponse
	});

	// @ts-ignore
	await t.throwsAsync(proxiedGot(server.url), {message: 'Error in mimic-response'});
});

test('errors are thrown directly when options.stream is true', t => {
	// @ts-ignore Manual tests
	t.throws(() => got('https://example.com', {stream: true, hooks: false}), {
		message: 'Parameter `hooks` must be an object, not boolean'
	});
});
