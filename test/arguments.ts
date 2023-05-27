import {parse} from 'node:url';
import test from 'ava';
import type {Handler} from 'express';
import {pEvent} from 'p-event';
import got, {Options, RequestError, type StrictOptions} from '../source/index.js';
import withServer, {withBodyParsingServer} from './helpers/with-server.js';
import invalidUrl from './helpers/invalid-url.js';

const echoUrl: Handler = (request, response) => {
	response.end(request.url);
};

test('`url` is required', async t => {
	await t.throwsAsync(
		// @ts-expect-error No argument on purpose.
		got(),
		{
			instanceOf: RequestError,
			message: 'Missing `url` property',
		},
	);

	const firstError = await t.throwsAsync(got(''));
	invalidUrl(t, firstError!, '');

	const secondError = await t.throwsAsync(got({url: ''}));
	invalidUrl(t, secondError!, '');
});

test('throws if no arguments provided', async t => {
	// @ts-expect-error Error tests
	await t.throwsAsync(got(), {
		instanceOf: RequestError,
		message: 'Missing `url` property',
	});
});

test('throws if the url option is missing', async t => {
	await t.throwsAsync(got({}), {
		instanceOf: RequestError,
		message: 'Missing `url` property',
	});
});

test('throws an error if the protocol is not specified', async t => {
	const error = await t.throwsAsync(got('example.com'));
	invalidUrl(t, error!, 'example.com');
});

test('properly encodes query string', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const path = '?test=http://example.com?foo=bar';
	const {body} = await got(path);
	t.is(body, '/?test=http://example.com?foo=bar');
});

test('options are optional', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	t.is((await got('test')).body, '/test');
});

test('methods are normalized', withServer, async (t, server, got) => {
	server.post('/test', echoUrl);

	const instance = got.extend({
		handlers: [
			(options, next) => {
				if (options.method === options.method.toUpperCase()) {
					t.pass();
				} else {
					t.fail();
				}

				return next(options);
			},
		],
	});

	await instance('test', {method: 'post'});
});

test('throws an error when legacy URL is passed', withServer, async (t, server) => {
	server.get('/test', echoUrl);

	await t.throwsAsync(
		// @ts-expect-error Error tests
		got(parse(`${server.url}/test`)),
		{
			instanceOf: RequestError,
			message: 'Expected value which is `predicate returns truthy for any value`, received values of types `Object`.',
		},
	);

	await t.throwsAsync(
		got({
			protocol: 'http:',
			hostname: 'localhost',
			port: server.port,
		} as any),
		{
			instanceOf: RequestError,
			message: 'Unexpected option: protocol',
		},
	);
});

test('overrides `searchParams` from options', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got(
		'?drop=this',
		{
			searchParams: {
				test: 'wow',
			},
		},
	);

	t.is(body, '/?test=wow');
});

test('does not duplicate `searchParams`', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const instance = got.extend({
		searchParams: new URLSearchParams({foo: '123'}),
	});

	const body = await instance('?bar=456').text();

	t.is(body, '/?foo=123');
});

test('escapes `searchParams` parameter values', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got({
		searchParams: {
			test: 'it’s ok',
		},
	});

	t.is(body, '/?test=it%E2%80%99s+ok');
});

test('the `searchParams` option can be a URLSearchParams', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	// eslint-disable-next-line unicorn/prevent-abbreviations
	const searchParams = new URLSearchParams({test: 'wow'});
	const {body} = await got({searchParams});
	t.is(body, '/?test=wow');
});

test('ignores empty searchParams object', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	t.is((await got('test', {searchParams: {}})).requestUrl.toString(), `${server.url}/test`);
});

test('throws when passing body with a non payload method', async t => {
	await t.throwsAsync(got('https://example.com', {body: 'asdf'}), {
		instanceOf: RequestError,
		message: 'The `GET` method cannot be used with a body',
	});
});

test('`allowGetBody` option', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	await t.notThrowsAsync(got('test', {body: 'asdf', allowGetBody: true}));
});

test('WHATWG URL support', withServer, async (t, server) => {
	server.get('/test', echoUrl);

	const url = new URL(`${server.url}/test`);
	await t.notThrowsAsync(got(url));
});

test('returns streams when using `isStream` option', withServer, async (t, server, got) => {
	server.get('/stream', (_request, response) => {
		response.end('ok');
	});

	const data = await pEvent(got('stream', {isStream: true}), 'data');
	t.is(data.toString(), 'ok');
});

test('accepts `url` as an option', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	await t.notThrowsAsync(got({url: 'test'}));
});

test('can omit `url` option if using `prefixUrl`', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	await t.notThrowsAsync(got({}));
});

test('throws when `options.hooks` is not an object', async t => {
	await t.throwsAsync(
		// @ts-expect-error Error tests
		got('https://example.com', {hooks: 'not object'}),
		{
			instanceOf: RequestError,
			message: 'Expected value which is `Object`, received value of type `string`.',
		},
	);
});

test('throws when known `options.hooks` value is not an array', async t => {
	await t.throwsAsync(
		// @ts-expect-error Error tests
		got('https://example.com', {hooks: {beforeRequest: {}}}),
		{
			instanceOf: RequestError,
			message: 'Expected value which is `predicate returns truthy for any value`, received values of types `Object`.',
		},
	);
});

test('throws when known `options.hooks` array item is not a function', async t => {
	await t.throwsAsync(
		// @ts-expect-error Error tests
		got('https://example.com', {hooks: {beforeRequest: [{}]}}),
		{
			instanceOf: RequestError,
			message: 'Expected value which is `Function`, received value of type `Object`.',
		},
	);
});

test('does not allow extra keys in `options.hooks`', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	// @ts-expect-error Error tests
	await t.throwsAsync(got('test', {hooks: {extra: []}}), {
		instanceOf: RequestError,
		message: 'Unexpected hook event: extra',
	});
});

test('`prefixUrl` option works', withServer, async (t, server, got) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({prefixUrl: `${server.url}/test`});
	const {body} = await instanceA('foobar');
	t.is(body, '/test/foobar');
});

test('accepts WHATWG URL as the `prefixUrl` option', withServer, async (t, server, got) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({prefixUrl: new URL(`${server.url}/test`)});
	const {body} = await instanceA('foobar');
	t.is(body, '/test/foobar');
});

test('backslash in the end of `prefixUrl` option is optional', withServer, async (t, server) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({prefixUrl: `${server.url}/test/`});
	const {body} = await instanceA('foobar');
	t.is(body, '/test/foobar');
});

test('`prefixUrl` can be changed if the URL contains the old one', withServer, async (t, server) => {
	server.get('/', echoUrl);

	const instanceA = got.extend({
		prefixUrl: `${server.url}/meh`,
		handlers: [
			(options, next) => {
				options.prefixUrl = server.url;
				return next(options);
			},
		],
	});

	const {body} = await instanceA('');
	t.is(body, '/');
});

test('throws if the `searchParams` value is invalid', async t => {
	await t.throwsAsync(got('https://example.com', {
		searchParams: {
			// @ts-expect-error Error tests
			foo: [],
		},
	}),
	{
		instanceOf: RequestError,
		message: 'Expected value which is `predicate returns truthy for any value`, received values of types `Array`.',
	});
});

test.failing('`context` option is enumerable', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const context = {
		foo: 'bar',
	};

	await got({
		context,
		hooks: {
			beforeRequest: [
				options => {
					t.deepEqual(options.context, context);
					t.true(Object.prototype.propertyIsEnumerable.call(options, 'context'));
				},
			],
		},
	});
});

test('`context` option is never frozen', t => {
	const client = got.extend({
		context: {
			token: 'foobar',
		},
	});

	client.defaults.options.context.token = '1234';

	t.is(client.defaults.options.context.token, '1234');
});

test('`context` option is accessible when using hooks', withServer, async (t, server) => {
	server.get('/', echoUrl);

	const context = {
		foo: 'bar',
	};

	await got(server.url, {
		context,
		hooks: {
			beforeRequest: [
				options => {
					t.deepEqual(options.context, context);
					t.false(Object.prototype.propertyIsEnumerable.call(options, 'context'));
				},
			],
		},
	});
});

test('`context` option is accessible when extending instances', t => {
	const context = {
		foo: 'bar',
	};

	const instance = got.extend({context});

	t.deepEqual(instance.defaults.options.context, context);
	t.false(Object.prototype.propertyIsEnumerable.call(instance.defaults.options, 'context'));
});

test('`context` option is shallow merged', t => {
	const context = {
		foo: 'bar',
	};

	const context2 = {
		bar: 'baz',
	};

	const instance1 = got.extend({context});

	t.deepEqual(instance1.defaults.options.context, context);
	t.false(Object.prototype.propertyIsEnumerable.call(instance1.defaults.options, 'context'));

	const instance2 = instance1.extend({context: context2});

	t.deepEqual(instance2.defaults.options.context, {...context, ...context2});
});

test('throws if `options.encoding` is `null`', async t => {
	await t.throwsAsync(got('https://example.com', {
		// @ts-expect-error For testing purposes
		encoding: null,
	}), {
		instanceOf: RequestError,
		message: 'To get a Buffer, set `options.responseType` to `buffer` instead',
	});
});

test('`url` option and input argument are mutually exclusive', async t => {
	await t.throwsAsync(got('https://example.com', {
		url: 'https://example.com',
	}), {
		instanceOf: RequestError,
		message: 'The `url` option is mutually exclusive with the `input` argument',
	});
});

test('throws a helpful error when passing `followRedirects`', async t => {
	await t.throwsAsync(got('https://example.com', {
		// @ts-expect-error For testing purposes
		followRedirects: true,
	}), {
		instanceOf: RequestError,
		message: 'The `followRedirects` option does not exist. Use `followRedirect` instead.',
	});
});

test('merges `searchParams` instances', t => {
	const instance = got.extend({
		searchParams: new URLSearchParams('a=1'),
	}, {
		searchParams: new URLSearchParams('b=2'),
	});

	// eslint-disable-next-line unicorn/prevent-abbreviations
	const searchParams = instance.defaults.options.searchParams as URLSearchParams;

	t.is(searchParams.get('a'), '1');
	t.is(searchParams.get('b'), '2');
});

test('throws a helpful error when passing `auth`', async t => {
	await t.throwsAsync(got('https://example.com', {
		// @ts-expect-error For testing purposes
		auth: 'username:password',
	}), {
		instanceOf: RequestError,
		message: 'Parameter `auth` is deprecated. Use `username` / `password` instead.',
	});
});

test('throws on leading slashes', async t => {
	await t.throwsAsync(got('/asdf', {prefixUrl: 'https://example.com'}), {
		instanceOf: RequestError,
		message: '`url` must not start with a slash',
	});
});

test('throws on invalid `dnsCache` option', async t => {
	await t.throwsAsync(got('https://example.com', {
		// @ts-expect-error Error tests
		dnsCache: 123,
	}),
	{
		instanceOf: RequestError,
		message: 'Expected value which is `predicate returns truthy for any value`, received values of types `number`.',
	});
});

test('throws on invalid `agent` option', async t => {
	await t.throwsAsync(got('https://example.com', {
		agent: {
			// @ts-expect-error Error tests
			asdf: 123,
		},
	}), {
		instanceOf: RequestError,
		message: 'Unexpected agent option: asdf',
	});
});

test('fallbacks to native http if `request(...)` returns undefined', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got('', {request: () => undefined});

	t.is(body, '/');
});

test('strict options', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const options: StrictOptions = {};

	const {body} = await got(options);

	t.is(body, '/');
});

test('does not throw on frozen options', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const options: StrictOptions = {};

	Object.freeze(options);

	const {body} = await got(options);

	t.is(body, '/');
});

test('encodes query string included in input', t => {
	const {url} = new Options({
		url: new URL('https://example.com/?a=b c'),
	});

	t.is(url!.search, '?a=b%20c');
});

test('normalizes search params included in options', t => {
	const {url} = new Options({
		url: new URL('https://example.com'),
		searchParams: 'a=b c',
	});

	t.is(url!.search, '?a=b+c');
});

test('reuse options while using init hook', withServer, async (t, server, got) => {
	t.plan(2);

	server.get('/', echoUrl);

	const options = {
		hooks: {
			init: [
				() => {
					t.pass();
				},
			],
		},
	};

	await got('', options);
	await got('', options);
});

test('allowGetBody sends json payload', withBodyParsingServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.body.hello !== 'world') {
			response.statusCode = 400;
		}

		response.end();
	});

	const {statusCode} = await got({
		allowGetBody: true,
		json: {hello: 'world'},
		retry: {
			limit: 0,
		},
		throwHttpErrors: false,
	});
	t.is(statusCode, 200);
});

test('no URL pollution', withServer, async (t, server) => {
	server.get('/ok', echoUrl);

	const url = new URL(server.url);

	const {body} = await got(url, {
		hooks: {
			beforeRequest: [
				options => {
					(options.url as URL).pathname = '/ok';
				},
			],
		},
	});

	t.is(url.pathname, '/');
	t.is(body, '/ok');
});

test('prefixUrl is properly replaced when extending', withServer, async (t, server) => {
	server.get('/', (request, response) => {
		response.end(request.url);
	});

	server.get('/other/path/', (request, response) => {
		response.end(request.url);
	});

	const parent = got.extend({prefixUrl: server.url});
	const child = parent.extend({prefixUrl: `${server.url}/other/path/`});

	t.is(await child.get('').text(), '/other/path/');
});

test('throws on too large noise', t => {
	/* eslint-disable no-new */
	t.throws(() => {
		new Options({
			retry: {
				noise: 101,
			},
		});
	}, {
		instanceOf: Error,
		message: 'The maximum acceptable retry noise is +/- 100ms, got 101',
	});

	t.throws(() => {
		new Options({
			retry: {
				noise: -101,
			},
		});
	}, {
		instanceOf: Error,
		message: 'The maximum acceptable retry noise is +/- 100ms, got -101',
	});

	t.throws(() => {
		new Options({
			retry: {
				noise: Number.POSITIVE_INFINITY,
			},
		});
	}, {
		instanceOf: Error,
		message: 'The maximum acceptable retry noise is +/- 100ms, got Infinity',
	});

	t.throws(() => {
		new Options({
			retry: {
				noise: Number.NEGATIVE_INFINITY,
			},
		});
	}, {
		instanceOf: Error,
		message: 'The maximum acceptable retry noise is +/- 100ms, got -Infinity',
	});

	t.notThrows(() => {
		new Options({
			retry: {
				noise: 0,
			},
		});
	});

	/* eslint-enable no-new */
});

test('options have url even if some are invalid', async t => {
	const error = await t.throwsAsync<RequestError>(got('https://example.com', {
		// @ts-expect-error Testing purposes
		invalid: true,
	}));

	t.is((error?.options.url as URL).href, 'https://example.com/');
	t.true(error instanceof Error);
});

test('options have url even if some are invalid - got.extend', async t => {
	const instance = got.extend({
		handlers: [
			(options, next) => {
				t.is((options.url as URL).href, 'https://example.com/');
				return next(options);
			},
		],
	});

	await t.throwsAsync(instance('https://example.com', {
		// @ts-expect-error Testing purposes
		invalid: true,
	}),
	{
		instanceOf: Error,
	});
});
