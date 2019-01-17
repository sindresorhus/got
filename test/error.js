import http from 'http';
import test from 'ava';
import getStream from 'get-stream';
import proxyquire from 'proxyquire';
import got from '../dist';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	s.on('/default-status-message', (request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	s.on('/custom-status-message', (request, response) => {
		response.statusCode = 400;
		response.statusMessage = 'Something Exploded';
		response.end('body');
	});

	s.on('/no-status-message', (request, response) => {
		response.writeHead(400, '');
		response.end('body');
	});

	s.on('/body', async (request, response) => {
		const body = await getStream(request);
		response.end(body);
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('properties', async t => {
	const error = await t.throwsAsync(got(s.url));
	t.truthy(error);
	t.truthy(error.response);
	t.false({}.propertyIsEnumerable.call(error, 'response'));
	t.false({}.hasOwnProperty.call(error, 'code'));
	t.is(error.message, 'Response code 404 (Not Found)');
	t.is(error.host, `${s.host}:${s.port}`);
	t.is(error.method, 'GET');
	t.is(error.protocol, 'http:');
	t.is(error.url, error.response.requestUrl);
	t.is(error.headers.connection, 'close');
	t.is(error.response.body, 'not');
});

test('dns message', async t => {
	const error = await t.throwsAsync(got('.com', {retry: 0}));
	t.truthy(error);
	t.regex(error.message, /getaddrinfo ENOTFOUND/);
	t.is(error.host, '.com');
	t.is(error.method, 'GET');
});

test('options.body form error message', async t => {
	await t.throwsAsync(got(s.url, {body: Buffer.from('test'), form: ''}), {
		message: 'The `body` option cannot be used with the `json` option or `form` option'
	});
});

test('no plain object restriction on json body', async t => {
	function CustomObject() {
		this.a = 123;
	}

	const body = await got(`${s.url}/body`, {json: new CustomObject()}).json();

	t.deepEqual(body, {a: 123});
});

test('default status message', async t => {
	const error = await t.throwsAsync(got(`${s.url}/default-status-message`));
	t.is(error.statusCode, 400);
	t.is(error.statusMessage, 'Bad Request');
});

test('custom status message', async t => {
	const error = await t.throwsAsync(got(`${s.url}/custom-status-message`));
	t.is(error.statusCode, 400);
	t.is(error.statusMessage, 'Something Exploded');
});

test('custom body', async t => {
	const error = await t.throwsAsync(got(s.url));
	t.is(error.statusCode, 404);
	t.is(error.body, 'not');
});

test('contains Got options', async t => {
	const options = {
		url: s.url,
		auth: 'foo:bar'
	};

	const error = await t.throwsAsync(got(options));
	t.is(error.gotOptions.auth, options.auth);
});

test('no status message is overriden by the default one', async t => {
	const error = await t.throwsAsync(got(`${s.url}/no-status-message`));
	t.is(error.statusCode, 400);
	t.is(error.statusMessage, http.STATUS_CODES[400]);
});

test('http.request error', async t => {
	await t.throwsAsync(got(s.url, {
		request: () => {
			throw new TypeError('The header content contains invalid characters');
		}
	}), {
		instanceOf: got.RequestError,
		message: 'The header content contains invalid characters'
	});
});

test('http.request pipe error', async t => {
	const message = 'snap!';

	await t.throwsAsync(got(s.url, {
		request: (...options) => {
			const modified = http.request(...options);
			modified.end = () => {
				modified.abort();
				throw new Error(message);
			};

			return modified;
		},
		throwHttpErrors: false
	}), {
		instanceOf: got.RequestError,
		message
	});
});

test('http.request error through CacheableRequest', async t => {
	await t.throwsAsync(got(s.url, {
		request: () => {
			throw new TypeError('The header content contains invalid characters');
		},
		cache: new Map()
	}), {
		instanceOf: got.RequestError,
		message: 'The header content contains invalid characters'
	});
});

test('catch error in mimicResponse', async t => {
	const mimicResponse = () => {
		throw new Error('Error in mimic-response');
	};

	mimicResponse['@global'] = true;

	const proxiedGot = proxyquire('..', {
		'mimic-response': mimicResponse
	});

	await t.throwsAsync(proxiedGot(s.url), {message: 'Error in mimic-response'});
});

test('errors are thrown directly when options.stream is true', t => {
	t.throws(() => got(s.url, {stream: true, hooks: false}), {
		message: 'Parameter `hooks` must be an object, not boolean'
	});
});
