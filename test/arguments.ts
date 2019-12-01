/* eslint-disable node/no-deprecated-api */
import {parse} from 'url';
import test from 'ava';
import {Handler} from 'express';
import pEvent = require('p-event');
import got from '../source';
import withServer from './helpers/with-server';

const echoUrl: Handler = (request, response) => {
	response.end(request.url);
};

test('`url` is required', async t => {
	await t.throwsAsync(
		// @ts-ignore Error tests
		got(''),
		{
			instanceOf: TypeError,
			message: 'No URL protocol specified'
		}
	);
});

test('`url` should be utf-8 encoded', async t => {
	await t.throwsAsync(
		got('https://example.com/%D2%E0%EB%EB%E8%ED'),
		{
			message: 'URI malformed'
		}
	);
});

test('throws if no arguments provided', async t => {
	// @ts-ignore Error tests
	await t.throwsAsync(got(), {
		instanceOf: TypeError,
		message: 'Missing `url` argument'
	});
});

test('throws an error if the protocol is not specified', async t => {
	await t.throwsAsync(got('example.com'), {
		instanceOf: TypeError,
		message: 'Invalid URL: example.com'
	});

	await t.throwsAsync(got({}), {
		instanceOf: TypeError,
		message: 'No URL protocol specified'
	});

	await t.throwsAsync(got({}), {
		instanceOf: TypeError,
		message: 'No URL protocol specified'
	});
});

test('string url with searchParams is preserved', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const path = '?test=http://example.com?foo=bar';
	const {body} = await got(path);
	t.is(body, `/${path}`);
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
			}
		]
	});

	await instance('test', {method: 'post'});
});

test('throws an error when legacy Url is passed', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	await t.throwsAsync(
		// @ts-ignore Error tests
		got(parse(`${server.url}/test`)),
		'The legacy `url.Url` is deprecated. Use `URL` instead.'
	);
});

test('overrides `searchParams` from options', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got(
		'?drop=this',
		{
			searchParams: {
				test: 'wow'
			},
			cache: {
				get(key: string) {
					t.is(key, `cacheable-request:GET:${server.url}/?test=wow`);
				},
				set(key: string) {
					t.is(key, `cacheable-request:GET:${server.url}/?test=wow`);
				},
				delete() {
					return true;
				},
				clear() {
					return undefined;
				}
			}
		}
	);

	t.is(body, '/?test=wow');
});

test('escapes `searchParams` parameter values', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got({
		searchParams: {
			test: 'it’s ok'
		}
	});

	t.is(body, '/?test=it%E2%80%99s+ok');
});

test('the `searchParams` option can be a URLSearchParams', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const searchParams = new URLSearchParams({test: 'wow'});
	const {body} = await got({searchParams});
	t.is(body, '/?test=wow');
});

test('ignores empty searchParams object', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	t.is((await got('test', {searchParams: {}})).requestUrl, `${server.url}/test`);
});

test('throws when passing body with a non payload method', async t => {
	// @ts-ignore Error tests
	await t.throwsAsync(got('https://example.com', {body: 'asdf'}), {
		instanceOf: TypeError,
		message: 'The `GET` method cannot be used with a body'
	});
});

test('WHATWG URL support', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	const wURL = new URL(`${server.url}/test`);
	await t.notThrowsAsync(got(wURL));
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

test('throws TypeError when `options.hooks` is not an object', async t => {
	await t.throwsAsync(
		// @ts-ignore Error tests
		got('https://example.com', {hooks: 'not object'}),
		{
			instanceOf: TypeError,
			message: 'Parameter `hooks` must be an Object, not string'
		}
	);
});

test('throws TypeError when known `options.hooks` value is not an array', async t => {
	await t.throwsAsync(
		// @ts-ignore Error tests
		got('https://example.com', {hooks: {beforeRequest: {}}}),
		{
			instanceOf: TypeError,
			message: 'Parameter `beforeRequest` must be an Array, not Object'
		}
	);
});

test('throws TypeError when known `options.hooks` array item is not a function', async t => {
	// @ts-ignore Error tests
	await t.throwsAsync(
		// @ts-ignore Error tests
		got('https://example.com', {hooks: {beforeRequest: [{}]}}),
		{
			instanceOf: TypeError,
			message: 'hook is not a function'
		}
	);
});

test('allows extra keys in `options.hooks`', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	// @ts-ignore We do not allow extra keys in hooks but this won't throw
	await t.notThrowsAsync(got('test', {hooks: {extra: []}}));
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
			}
		]
	});

	const {body} = await instanceA('');
	t.is(body, '/');
});

test('throws if cannot change `prefixUrl`', async t => {
	const instanceA = got.extend({
		prefixUrl: 'https://example.com',
		handlers: [
			(options, next) => {
				options.url = new URL('https://google.pl');
				options.prefixUrl = 'https://example.com';
				return next(options);
			}
		]
	});

	await t.throwsAsync(instanceA(''), 'Cannot change `prefixUrl` from https://example.com/ to https://example.com: https://google.pl/');
});

test('throws if the `searchParams` value is invalid', async t => {
	// @ts-ignore Error tests
	await t.throwsAsync(got('https://example.com', {
		// @ts-ignore Error tests
		searchParams: {
			foo: []
		}
	}), {
		instanceOf: TypeError,
		message: 'The `searchParams` value \'\' must be a string, number, boolean or null'
	});
});

test('`context` option is not enumerable', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const context = {
		foo: 'bar'
	};

	await got({
		context,
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.context, context);
					t.false({}.propertyIsEnumerable.call(options, 'context'));
				}
			]
		}
	});
});

test('`context` option is accessible when using hooks', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const context = {
		foo: 'bar'
	};

	await got({
		context,
		hooks: {
			init: [
				options => {
					t.is(options.context, context);
					t.false({}.propertyIsEnumerable.call(options, 'context'));
				}
			]
		}
	});
});

test('`context` option is accessible when extending instances', t => {
	const context = {
		foo: 'bar'
	};

	const instance = got.extend({context});

	t.is(instance.defaults.options.context, context);
	t.false({}.propertyIsEnumerable.call(instance.defaults.options, 'context'));
});

test('throws if `options.encoding` is `null`', async t => {
	// @ts-ignore Error tests
	await t.throwsAsync(got('https://example.com', {
		encoding: null
	}), 'To get a Buffer, set `options.responseType` to `buffer` instead');
});
