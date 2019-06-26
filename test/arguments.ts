/* eslint-disable node/no-deprecated-api */
import {URL, URLSearchParams, parse} from 'url';
import test from 'ava';
import pEvent = require('p-event');
import got from '../source';
import withServer from './helpers/with-server';

const echoUrl = (request, response) => {
	response.end(request.url);
};

test('`url` is required', async t => {
	await t.throwsAsync(
		// @ts-ignore Manual tests
		got(),
		{
			instanceOf: TypeError,
			message: 'Parameter `url` must be a string or object, not undefined'
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

test('throws an error if the protocol is not specified', async t => {
	await t.throwsAsync(got('example.com'), {
		instanceOf: TypeError,
		message: 'Invalid URL: example.com'
	});
});

test('string url with searchParams is preserved', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const path = '/?test=http://example.com?foo=bar';
	const {body} = await got(path);
	t.is(body, path);
});

test('options are optional', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	t.is((await got('test')).body, '/test');
});

test('methods are normalized', withServer, async (t, server, got) => {
	server.post('/test', echoUrl);

	const instance = got.create({
		methods: got.defaults.methods,
		options: got.defaults.options,
		handler: (options, next) => {
			if (options.method === options.method.toUpperCase()) {
				t.pass();
			} else {
				t.fail();
			}

			return next(options);
		}
	});

	await instance('test', {method: 'post'});
});

test('accepts url.parse object as first argument', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	t.is((await got(parse(`${server.url}/test`))).body, '/test');
});

test('requestUrl with url.parse object as first argument', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	t.is((await got(parse(`${server.url}/test`))).requestUrl, `${server.url}/test`);
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
				get(key) {
					t.is(key, `cacheable-request:GET:${server.url}/?test=wow`);
				},
				set(key) {
					t.is(key, `cacheable-request:GET:${server.url}/?test=wow`);
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

test('throws on invalid type of body', async t => {
	// @ts-ignore Manual tests
	await t.throwsAsync(got('https://example.com', {body: false}), {
		instanceOf: TypeError,
		message: 'The `GET` method cannot be used with a body'
	});
});

test('WHATWG URL support', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	const wURL = new URL(`${server.url}/test`);
	await t.notThrowsAsync(got(wURL));
});

test('returns streams when using stream option', withServer, async (t, server, got) => {
	server.get('/stream', (_request, response) => {
		response.end('ok');
	});

	const data = await pEvent(got('stream', {stream: true}), 'data');
	t.is(data.toString(), 'ok');
});

test('accepts `url` as an option', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	await t.notThrowsAsync(got({url: 'test'}));
});

test('can omit `url` option if using `baseUrl`', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	await t.notThrowsAsync(got({}));
});

test('throws TypeError when `options.hooks` is not an object', async t => {
	await t.throwsAsync(
		// @ts-ignore Manual tests
		got('https://example.com', {hooks: 'not object'}),
		{
			instanceOf: TypeError,
			message: 'Parameter `hooks` must be an object, not string'
		}
	);
});

test('throws TypeError when known `options.hooks` value is not an array', async t => {
	await t.throwsAsync(
		// @ts-ignore Manual tests
		got('https://example.com', {hooks: {beforeRequest: {}}}),
		{
			instanceOf: TypeError,
			message: 'options.hooks.beforeRequest is not iterable'
		}
	);
});

test('throws TypeError when known `options.hooks` array item is not a function', async t => {
	await t.throwsAsync(
		// @ts-ignore Manual tests
		got('https://example.com', {hooks: {beforeRequest: [{}]}}),
		{
			instanceOf: TypeError,
			message: 'hook is not a function'
		}
	);
});

test('allows extra keys in `options.hooks`', withServer, async (t, server, got) => {
	server.get('/test', echoUrl);

	await t.notThrowsAsync(got('test', {hooks: {extra: {}}}));
});

test('`baseUrl` option works', withServer, async (t, server, got) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({baseUrl: `${server.url}/test`});
	const {body} = await instanceA('/foobar');
	t.is(body, '/test/foobar');
});

test('accepts WHATWG URL as the `baseUrl` option', withServer, async (t, server, got) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({baseUrl: new URL(`${server.url}/test`)});
	const {body} = await instanceA('/foobar');
	t.is(body, '/test/foobar');
});

test('backslash in the end of `baseUrl` option is optional', withServer, async (t, server) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({baseUrl: `${server.url}/test/`});
	const {body} = await instanceA('/foobar');
	t.is(body, '/test/foobar');
});

test('backslash in the beginning of `url` is optional when using `baseUrl` option', withServer, async (t, server) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({baseUrl: `${server.url}/test`});
	const {body} = await instanceA('foobar');
	t.is(body, '/test/foobar');
});

test('throws when trying to modify `baseUrl` after options got normalized', async t => {
	const instanceA = got.create({
		methods: [],
		options: {baseUrl: 'https://example.com'},
		handler: (options, next) => {
			options.baseUrl = 'https://google.com';
			return next(options);
		}
	});

	await t.throwsAsync(instanceA('/'), 'Failed to set baseUrl. Options are normalized already.');
});

test('throws if the `searchParams` value is invalid', async t => {
	await t.throwsAsync(got('https://example.com', {
		// @ts-ignore Manual tests
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
