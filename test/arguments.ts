import {Buffer} from 'node:buffer';
import {request as httpRequest, get as httpGet, type IncomingMessage} from 'node:http';
import {connect} from 'node:net';
import assert from 'node:assert/strict';
import type {Handler} from 'express';
import getStream from 'get-stream';
import Responselike from 'responselike';
import got, {Options, RequestError, type StrictOptions} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import {throws} from './helpers/throws.js';
import test from './helpers/test.js';
import withServer, {withBodyParsingServer} from './helpers/with-server.js';
import invalidUrl from './helpers/invalid-url.js';

const echoUrl: Handler = (request, response) => {
	response.end(request.url);
};

test('normalized request hooks accept setter inputs and expose normalized values', withServer, async (_t, server, got) => {
	server.get('/target', (_request, response) => {
		response.end('target');
	});

	const response = await got('original', {
		hooks: {
			beforeRequest: [options => {
				options.url = `${server.url}/target`;
				options.prefixUrl = new URL(server.url);
				options.dnsCache = true;
				assert.strictEqual(options.url instanceof URL, true);
				assert.strictEqual(options.prefixUrl, `${server.url}/`);
				assert.strictEqual(typeof options.dnsCache?.lookup, 'function');
				options.dnsCache = false;
				assert.strictEqual(options.dnsCache, undefined);
			}],
		},
	});

	assert.strictEqual(response.body, 'target');
});

test('normalized redirect hooks accept string URL assignments', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.writeHead(302, {location: '/unused'}).end();
	});
	server.get('/target', (_request, response) => {
		response.end('redirect target');
	});

	const response = await got('original', {
		hooks: {
			beforeRedirect: [options => {
				options.url = `${server.url}/target`;
				assert.strictEqual(options.url instanceof URL, true);
			}],
		},
	});

	assert.strictEqual(response.body, 'redirect target');
});

test('`url` is required', async _t => {
	await assert.rejects(
		// @ts-expect-error No argument on purpose.
		got(),
		errorMatching(RequestError, {message: 'Missing `url` property'}),
	);

	const firstError = await rejects(got(''));
	invalidUrl(firstError, '');

	assert.throws(() => {
		void got({url: ''} as any);
	}, errorMatching(TypeError, {message: 'The `url` option is not supported in options objects. Pass it as the first argument instead.'}));
});

test('throws if no arguments provided', async _t => {
	// @ts-expect-error Error tests
	await assert.rejects(got(), errorMatching(RequestError, {message: 'Missing `url` property'}));
});

test('throws if the url option is missing', async _t => {
	await assert.rejects(got({}), errorMatching(RequestError, {message: 'Missing `url` property'}));
});

test('throws if an invalid argument is passed', async _t => {
	await assert.rejects(
		// @ts-expect-error Error tests
		got(false),
		errorMatching(RequestError, {message: 'Option \'input\': Expected values which are `string`, `URL`, `Object`, or `undefined`. Received values of type `boolean`.'}),
	);
});

test('throws an error if the protocol is not specified', async _t => {
	const error = await rejects(got('example.com'));
	invalidUrl(error, 'example.com');
});

test('properly encodes query string', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const path = '?test=http://example.com?foo=bar';
	const {body} = await got(path);
	assert.strictEqual(body, '/?test=http://example.com?foo=bar');
});

test('options are optional', withServer, async (_t, server, got) => {
	server.get('/test', echoUrl);

	assert.strictEqual((await got('test')).body, '/test');
});

test('methods are normalized', withServer, async (_t, server, got) => {
	server.post('/test', echoUrl);

	let seenMethod: string | undefined;
	const instance = got.extend({
		handlers: [
			(options, next) => {
				seenMethod = options.method;
				return next(options);
			},
		],
	});

	await instance('test', {method: 'post'});

	// The handler has to run, otherwise the assertion below would pass without proving anything.
	assert.strictEqual(seenMethod, 'POST');
});

test('QUERY method is normalized', withServer, async (_t, server, got) => {
	server.all('/test', async (request, response) => {
		assert.strictEqual(request.method, 'QUERY');
		assert.strictEqual(request.headers['content-type'], 'application/json');
		response.end(await getStream(request));
	});

	const payload = {
		query: true,
	};

	const body = await got('test', {
		method: 'query',
		json: payload,
	}).json<typeof payload>();

	assert.deepStrictEqual(body, payload);
});

test('throws an error when legacy URL is passed', withServer, async (_t, server) => {
	server.get('/test', echoUrl);

	await assert.rejects(
		got({href: `${server.url}/test`} as any),
		errorMatching(RequestError, {message: 'Unexpected option: href'}),
	);

	await assert.rejects(
		got({
			protocol: 'http:',
			hostname: 'localhost',
			port: server.port,
		} as any),
		errorMatching(RequestError, {message: 'Unexpected option: protocol'}),
	);
});

test('overrides `searchParams` from options', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got(
		'?drop=this',
		{
			searchParams: {
				test: 'wow',
			},
		},
	);

	assert.strictEqual(body, '/?test=wow');
});

test('does not duplicate `searchParams`', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const instance = got.extend({
		searchParams: new URLSearchParams({foo: '123'}),
	});

	const body = await instance('?bar=456').text();

	assert.strictEqual(body, '/?foo=123');
});

test('escapes `searchParams` parameter values', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got({
		searchParams: {
			test: 'it’s ok',
		},
	});

	assert.strictEqual(body, '/?test=it%E2%80%99s+ok');
});

test('the `searchParams` option can be a URLSearchParams', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const searchParameters = new URLSearchParams({test: 'wow'});
	const {body} = await got({searchParams: searchParameters});
	assert.strictEqual(body, '/?test=wow');
});

test('ignores empty searchParams object', withServer, async (_t, server, got) => {
	server.get('/test', echoUrl);

	assert.strictEqual((await got('test', {searchParams: {}})).requestUrl.href, `${server.url}/test`);
});

test('throws when passing body with a non payload method', async _t => {
	await assert.rejects(got('https://example.com', {body: 'asdf'}), errorMatching(RequestError, {message: 'The `GET` method cannot be used with a body'}));
});

test('`allowGetBody` option', withServer, async (_t, server, got) => {
	server.get('/test', echoUrl);

	await assert.doesNotReject(got('test', {body: 'asdf', allowGetBody: true}));
});

test('WHATWG URL support', withServer, async (_t, server) => {
	server.get('/test', echoUrl);

	const url = new URL(`${server.url}/test`);
	await assert.doesNotReject(got(url));
});

test('ordinary http://unix host does not require UNIX socket opt-in', async _t => {
	const {body} = await got('http://unix/', {
		hooks: {
			beforeRequest: [
				() => new Responselike({
					statusCode: 200,
					body: Buffer.from('ok'),
					headers: {},
					url: 'http://unix/',
				}),
			],
		},
	});

	assert.strictEqual(body, 'ok');
});

test('`got.stream()` exposes internal `isStream` in init hook context', withServer, async (_t, server, got) => {
	server.get('/stream', (_request, response) => {
		response.end('ok');
	});

	const streamWithInput = got.stream('stream', {
		hooks: {
			init: [
				plain => {
					assert.strictEqual(Reflect.get(plain, 'isStream') === true, true);
				},
			],
		},
	});

	assert.strictEqual(await getStream(streamWithInput), 'ok');
});

test('`got.stream()` with a single options object calls init hooks once', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let count = 0;

	const stream = got.stream({
		hooks: {
			init: [
				() => {
					count++;
				},
			],
		},
	});

	assert.strictEqual(await getStream(stream), 'ok');
	assert.strictEqual(count, 1);
});

test('`got.stream()` preserves non-enumerable options on a single options object', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers.token);
	});

	const options = {
		hooks: {
			beforeRequest: [
				(options: any) => {
					options.headers.token = String(options.context.token);
				},
			],
		},
	};

	Object.defineProperty(options, 'context', {
		value: {token: 'secret'},
		enumerable: false,
		configurable: true,
		writable: true,
	});

	const stream = got.stream(options);

	assert.strictEqual(await getStream(stream), 'secret');
});

test('`isStream` option is ignored on promise API', withServer, async (_t, server, got) => {
	server.get('/stream', (_request, response) => {
		response.end('ok');
	});

	const result = got('stream', {
		// @ts-expect-error Removed option
		isStream: true,
	});

	assert.strictEqual(typeof result.then === 'function', true);
	assert.strictEqual(await result.text(), 'ok');
});

test('throws when `url` is passed in options object', _t => {
	assert.throws(() => {
		void got({url: 'https://example.com'} as any);
	}, errorMatching(TypeError, {message: 'The `url` option is not supported in options objects. Pass it as the first argument instead.'}));
});

test('throws when `url` is passed in stream options object', _t => {
	const error = throws(() => {
		got.stream({url: 'https://example.com'} as any);
	});

	assert.strictEqual(error instanceof TypeError, true);
	assert.strictEqual(error.message, 'The `url` option is not supported in options objects. Pass it as the first argument instead.');
});

test('throws when `url` is passed as second argument option', _t => {
	const error = throws(() => {
		void got('https://example.com', {url: 'https://example.com'} as any);
	});

	assert.strictEqual(error instanceof TypeError, true);
	assert.strictEqual(error.message, 'The `url` option is not supported in options objects. Pass it as the first argument instead.');
});

test('throws when `url` is passed to extend defaults', _t => {
	const error = throws(() => {
		got.extend({url: 'https://example.com'} as any);
	});

	assert.strictEqual(error instanceof TypeError, true);
	assert.strictEqual(error.message, 'The `url` option is not supported in options objects. Pass it as the first argument instead.');
});

test('can omit `url` option if using `prefixUrl`', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	await assert.doesNotReject(got({}));
});

test('throws when `options.hooks` is not an object', async _t => {
	await assert.rejects(
		// @ts-expect-error Error tests
		got('https://example.com', {hooks: 'not object'}),
		errorMatching(RequestError, {message: 'Expected value which is `Object`, received value of type `string`.'}),
	);
});

test('throws when known `options.hooks` value is not an array', async _t => {
	await assert.rejects(
		// @ts-expect-error Error tests
		got('https://example.com', {hooks: {beforeRequest: {}}}),
		errorMatching(RequestError, {message: 'Option \'hooks.beforeRequest\': Expected values which are `Array` or `undefined`. Received values of type `Object`.'}),
	);
});

test('throws when known `options.hooks` array item is not a function', async _t => {
	await assert.rejects(
		// @ts-expect-error Error tests
		got('https://example.com', {hooks: {beforeRequest: [{}]}}),
		errorMatching(RequestError, {message: 'Expected value which is `Function`, received value of type `Object`.'}),
	);
});

test('does not allow extra keys in `options.hooks`', withServer, async (_t, server, got) => {
	server.get('/test', echoUrl);

	// @ts-expect-error Error tests
	await assert.rejects(got('test', {hooks: {extra: []}}), errorMatching(RequestError, {message: 'Unexpected hook event: extra'}));
});

test('`prefixUrl` option works', withServer, async (_t, server, got) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({prefixUrl: `${server.url}/test`});
	const {body} = await instanceA('foobar');
	assert.strictEqual(body, '/test/foobar');
});

test('absolute URL input bypasses `prefixUrl` by default', withServer, async (t, _server, got) => {
	await withServer(t, async (_t, server2) => {
		server2.get('/test', echoUrl);

		const {body} = await got(`${server2.url}/test`);
		assert.strictEqual(body, '/test');
	});
});

test('`allowAbsoluteUrls: false` rejects absolute string input when `prefixUrl` is set', withServer, async (_t, server, got) => {
	await assert.rejects(got(server.url, {allowAbsoluteUrls: false}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('`allowAbsoluteUrls: false` rejects URL instance input when `prefixUrl` is set', withServer, async (_t, server, got) => {
	await assert.rejects(got(new URL(server.url), {allowAbsoluteUrls: false}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('`allowAbsoluteUrls: false` rejects a tab-normalized absolute string input when `prefixUrl` is set', withServer, async (_t, _server, got) => {
	await assert.rejects(got('\thttp://example.com', {allowAbsoluteUrls: false}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('`allowAbsoluteUrls: false` allows relative input when `prefixUrl` is set', withServer, async (_t, server, got) => {
	server.get('/test', echoUrl);

	const {body} = await got('test', {allowAbsoluteUrls: false});
	assert.strictEqual(body, '/test');
});

test('clearing `prefixUrl` allows absolute URLs when `allowAbsoluteUrls` is false', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got(server.url, {
		allowAbsoluteUrls: false,
		prefixUrl: '',
	});
	assert.strictEqual(body, '/');
});

test('accepts WHATWG URL as the `prefixUrl` option', withServer, async (_t, server, got) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({prefixUrl: new URL(`${server.url}/test`)});
	const {body} = await instanceA('foobar');
	assert.strictEqual(body, '/test/foobar');
});

test('backslash in the end of `prefixUrl` option is optional', withServer, async (_t, server) => {
	server.get('/test/foobar', echoUrl);

	const instanceA = got.extend({prefixUrl: `${server.url}/test/`});
	const {body} = await instanceA('foobar');
	assert.strictEqual(body, '/test/foobar');
});

test('`prefixUrl` can be changed if the URL contains the old one', withServer, async (_t, server) => {
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
	assert.strictEqual(body, '/');
});

test('`allowAbsoluteUrls: false` rejects handler mutation to absolute URL when `prefixUrl` is set', withServer, async (_t, server, got) => {
	const instance = got.extend({
		allowAbsoluteUrls: false,
		handlers: [
			(options, next) => {
				options.url = new URL(`${server.url}/changed`);
				return next(options);
			},
		],
	});

	await assert.rejects(async () => instance(''), errorMatching(Error, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('`allowAbsoluteUrls: false` rejects handler URL object mutation outside `prefixUrl` origin', withServer, async (_t, _server, got) => {
	const instance = got.extend({
		allowAbsoluteUrls: false,
		handlers: [
			(options, next) => {
				(options.url as URL).hostname = 'example.com';
				return next(options);
			},
		],
	});

	await assert.rejects(async () => instance(''), errorMatching(Error, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
});

test('`allowAbsoluteUrls: false` rejects handler prefixUrl mutation around absolute URL', withServer, async (_t, server) => {
	const instance = got.extend({
		allowAbsoluteUrls: false,
		prefixUrl: '',
		handlers: [
			(options, next) => {
				options.prefixUrl = server.url;
				return next(options);
			},
		],
	});

	await assert.rejects(async () => instance('https://example.com/'), errorMatching(Error, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
});

test('throws if the `searchParams` value is invalid', async _t => {
	await assert.rejects(
		got('https://example.com', {
			searchParams: {
			// @ts-expect-error Error tests
				foo: [],
			},
		}),
		errorMatching(RequestError, {message: 'Option \'searchParams.foo\': Expected values which are `string`, `number`, `boolean`, `null`, or `undefined`. Received values of type `Array`.'}),
	);
});

// Note: This test was added in commit 2b8ed1f (Oct 2020) when context was changed to be enumerable,
// but it has been marked as .failing since it was introduced. The feature was never fully implemented
// because making context enumerable breaks other tests that expect it to be non-enumerable.
// This represents an unfinished feature request from 3+ years ago, not a recent regression.
test.failing('`context` option is enumerable', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const context = {
		foo: 'bar',
	};

	await got({
		context,
		hooks: {
			beforeRequest: [
				options => {
					assert.deepStrictEqual(options.context, context);
					assert.strictEqual(Object.prototype.propertyIsEnumerable.call(options, 'context'), true);
				},
			],
		},
	});
});

test('`context` option is never frozen', _t => {
	const client = got.extend({
		context: {
			token: 'foobar',
		},
	});

	client.defaults.options.context.token = '1234';

	assert.strictEqual(client.defaults.options.context.token, '1234');
});

test('`context` option is accessible when using hooks', withServer, async (_t, server) => {
	server.get('/', echoUrl);

	const context = {
		foo: 'bar',
	};

	let calls = 0;
	await got(server.url, {
		context,
		hooks: {
			beforeRequest: [
				options => {
					calls++;
					assert.deepStrictEqual(options.context, context);
					assert.strictEqual(Object.prototype.propertyIsEnumerable.call(options, 'context'), false);
				},
			],
		},
	});

	assert.strictEqual(calls, 1);
});

test('`context` option is accessible when extending instances', _t => {
	const context = {
		foo: 'bar',
	};

	const instance = got.extend({context});

	assert.deepStrictEqual(instance.defaults.options.context, context);
	assert.strictEqual(Object.prototype.propertyIsEnumerable.call(instance.defaults.options, 'context'), false);
});

test('`context` option is shallow merged', _t => {
	const context = {
		foo: 'bar',
	};

	const context2 = {
		bar: 'baz',
	};

	const instance1 = got.extend({context});

	assert.deepStrictEqual(instance1.defaults.options.context, context);
	assert.strictEqual(Object.prototype.propertyIsEnumerable.call(instance1.defaults.options, 'context'), false);

	const instance2 = instance1.extend({context: context2});

	assert.deepStrictEqual(instance2.defaults.options.context, {...context, ...context2});
});

test('throws if `options.encoding` is `null`', async _t => {
	await assert.rejects(got('https://example.com', {
		// @ts-expect-error For testing purposes
		encoding: null,
	}), errorMatching(RequestError, {message: 'To get a Uint8Array, set `options.responseType` to `buffer` instead'}));
});

test('throws when `url` is passed as option with input argument', _t => {
	const error = throws(() => {
		void got('https://example.com', {
			url: 'https://example.com',
		} as any);
	});

	assert.strictEqual(error instanceof TypeError, true);
	assert.strictEqual(error.message, 'The `url` option is not supported in options objects. Pass it as the first argument instead.');
});

test('merges `searchParams` instances', _t => {
	const instance = got.extend({
		searchParams: new URLSearchParams('a=1'),
	}, {
		searchParams: new URLSearchParams('b=2'),
	});

	const searchParameters = instance.defaults.options.searchParams as URLSearchParams;

	assert.strictEqual(searchParameters.get('a'), '1');
	assert.strictEqual(searchParameters.get('b'), '2');
});

test('throws on leading slashes', async _t => {
	await assert.rejects(got('/asdf', {prefixUrl: 'https://example.com'}), errorMatching(RequestError, {message: '`url` must not start with a slash'}));
});

test('throws on scheme-like urls without protocol slashes', async _t => {
	await assert.rejects(got('https:google.com'), errorMatching(RequestError, {message: '`url` protocol must be followed by `//`'}));
});

test('throws on invalid `dnsCache` option', async _t => {
	await assert.rejects(
		got('https://example.com', {
			// @ts-expect-error Error tests
			dnsCache: 123,
		}),
		errorMatching(RequestError, {message: 'Option \'dnsCache\': Expected values which are `Object`, `boolean`, or `undefined`. Received values of type `number`.'}),
	);
});

test('throws on invalid `dnsCache.lookup` option', async _t => {
	await assert.rejects(
		got('https://example.com', {
			// @ts-expect-error Error tests
			dnsCache: {},
		}),
		errorMatching(RequestError, {message: 'Option \'dnsCache.lookup\': Expected values which are `Function`. Received values of type `undefined`.'}),
	);
});

test('throws on invalid `dnsCache.clear` option', async _t => {
	await assert.rejects(
		got('https://example.com', {
			dnsCache: {
				lookup() {},
				// @ts-expect-error Error tests
				clear: 123,
			},
		}),
		errorMatching(RequestError, {message: 'Option \'dnsCache.clear\': Expected values which are `Function` or `undefined`. Received values of type `number`.'}),
	);
});

test('throws on invalid `agent` option', async _t => {
	await assert.rejects(got('https://example.com', {
		agent: {
			// @ts-expect-error Error tests
			asdf: 123,
		},
	}), errorMatching(RequestError, {message: 'Unexpected agent option: asdf'}));
});

test('fallbacks to native http if `request(...)` returns undefined', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got('', {request: () => undefined});

	assert.strictEqual(body, '/');
});

test('fallbacks to native http if async `request(...)` resolves to undefined', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got('', {request: async () => undefined});

	assert.strictEqual(body, '/');
});

test('strict options', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const options: StrictOptions = {};

	const {body} = await got(options);

	assert.strictEqual(body, '/');
});

test('does not throw on frozen options', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	const options: StrictOptions = {};

	Object.freeze(options);

	const {body} = await got(options);

	assert.strictEqual(body, '/');
});

test('encodes query string included in input', _t => {
	const {url} = new Options({
		url: new URL('https://example.com/?a=b c'),
	});

	assert.strictEqual(url!.search, '?a=b%20c');
});

test('normalizes search params included in options', _t => {
	const {url} = new Options({
		url: new URL('https://example.com'),
		searchParams: 'a=b c',
	});

	assert.strictEqual(url!.search, '?a=b+c');
});

test('reuse options while using init hook', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);

	let initCalls = 0;
	const options = {
		hooks: {
			init: [
				() => {
					initCalls++;
				},
			],
		},
	};

	await got('', options);
	await got('', options);

	// The init hook must run for each request, even though the same options object is reused.
	assert.strictEqual(initCalls, 2);
});

test('allowGetBody sends json payload', withBodyParsingServer, async (_t, server, got) => {
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
	assert.strictEqual(statusCode, 200);
});

test('no URL pollution', withServer, async (_t, server) => {
	server.get('/ok', echoUrl);

	const url = new URL(server.url);

	const {body} = await got(url, {
		hooks: {
			beforeRequest: [
				options => {
					options.url!.pathname = '/ok';
				},
			],
		},
	});

	assert.strictEqual(url.pathname, '/');
	assert.strictEqual(body, '/ok');
});

test('prefixUrl is properly replaced when extending', withServer, async (_t, server) => {
	server.get('/', (request, response) => {
		response.end(request.url);
	});

	server.get('/other/path/', (request, response) => {
		response.end(request.url);
	});

	const parent = got.extend({prefixUrl: server.url});
	const child = parent.extend({prefixUrl: `${server.url}/other/path/`});

	assert.strictEqual(await child.get('').text(), '/other/path/');
});

test('throws on too large noise', _t => {
	/* eslint-disable no-new -- Testing that the Options constructor throws; side-effect is the point */
	assert.throws(() => {
		new Options({
			retry: {
				noise: 101,
			},
		});
	}, errorMatching(Error, {message: 'The maximum acceptable retry noise is +/- 100ms, got 101'}));

	assert.throws(() => {
		new Options({
			retry: {
				noise: -101,
			},
		});
	}, errorMatching(Error, {message: 'The maximum acceptable retry noise is +/- 100ms, got -101'}));

	assert.throws(() => {
		new Options({
			retry: {
				noise: Infinity,
			},
		});
	}, errorMatching(Error, {message: 'The maximum acceptable retry noise is +/- 100ms, got Infinity'}));

	assert.throws(() => {
		new Options({
			retry: {
				noise: -Infinity,
			},
		});
	}, errorMatching(Error, {message: 'The maximum acceptable retry noise is +/- 100ms, got -Infinity'}));

	assert.doesNotThrow(() => {
		new Options({
			retry: {
				noise: 0,
			},
		});
	});

	/* eslint-enable no-new */
});

test('options have url even if some are invalid', async _t => {
	const error = await rejects(got('https://example.com', {
		// @ts-expect-error Testing purposes
		invalid: true,
	}));

	assert.strictEqual((error.options.url! as URL).href, 'https://example.com/');
	assert.strictEqual(error instanceof Error, true);
});

test('options have url even if some are invalid - got.extend', async _t => {
	const instance = got.extend({
		handlers: [
			(options, next) => {
				assert.strictEqual((options.url! as URL).href, 'https://example.com/');
				return next(options);
			},
		],
	});

	await assert.rejects(
		instance('https://example.com', {
		// @ts-expect-error Testing purposes
			invalid: true,
		}),
		Error,
	);
});

test('request header array mutations do not affect later requests', withServer, async (_t, server) => {
	server.get('/', (request, response) => {
		response.end(request.headers['x-values']);
	});

	const client = got.extend({headers: {'x-values': ['default']}});
	assert.strictEqual(await client(server.url, {
		hooks: {
			beforeRequest: [options => {
				(options.headers['x-values'] as string[]).push('request');
			}],
		},
	}).text(), 'default, request');
	assert.strictEqual(await client(server.url).text(), 'default');
});

test('mutating caller header arrays after extension does not change defaults', _t => {
	const values = ['original'];
	const client = got.extend({headers: {'x-values': values}});
	values.push('changed');

	assert.deepStrictEqual(client.defaults.options.headers['x-values'], ['original']);
});

test('explicit undefined search parameters reset inherited query defaults', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);
	const instance = got.extend({searchParams: {page: 1, format: 'json'}});

	assert.strictEqual(await instance('', {searchParams: undefined}).text(), '/');
});

test('resetting inherited search parameters preserves the input URL query', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);
	const instance = got.extend({searchParams: {page: 1}});

	assert.strictEqual(await instance('?query=original', {searchParams: undefined}).text(), '/?query=original');
	assert.strictEqual(await instance('').text(), '/?page=1');
});

test('extended search parameter resets survive merging into another instance', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);
	const parent = got.extend({searchParams: {page: 1}});
	const child = parent.extend({searchParams: undefined});
	const merged = got.extend({searchParams: {format: 'json'}}, child);

	assert.strictEqual(await child('').text(), '/');
	assert.strictEqual(await merged('').text(), '/');
	assert.strictEqual(await child('', {searchParams: {page: 2}}).text(), '/?page=2');
});

test('typed null search parameters overwrite values with an empty string', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);
	const instance = got.extend({searchParams: {empty: 'previous', retained: 'yes'}});

	assert.strictEqual(await instance('', {searchParams: {empty: null}}).text(), '/?retained=yes&empty=');
});

test('typed null and undefined search parameters retain their distinct meanings', withServer, async (_t, server, got) => {
	server.get('/', echoUrl);
	const instance = got.extend({searchParams: {empty: 'previous', removed: 'previous'}});

	assert.strictEqual(await instance('', {
		searchParams: {
			empty: null,
			removed: undefined,
			zero: 0,
			disabled: false,
		},
	}).text(), '/?empty=&zero=0&disabled=false');
});

test('mutable defaults permit changing pagination settings', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('[1, 2]');
	});
	const instance = got.extend({mutableDefaults: true});
	instance.defaults.options.pagination.countLimit = 1;

	assert.deepStrictEqual(await instance.paginate.all<number>(''), [1]);
});

test('per-request pagination settings can override immutable defaults', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('[1, 2]');
	});
	const instance = got.extend({pagination: {countLimit: 2}});

	assert.deepStrictEqual(await instance.paginate.all<number>('', {pagination: {countLimit: 1}}), [1]);
	assert.deepStrictEqual(await instance.paginate.all<number>(''), [1, 2]);
});

test('DataView request bodies preserve their offset and content length', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({body: await getStream(request), length: request.headers['content-length']});
	});
	const bytes = new TextEncoder().encode('before:payload:after');
	const body = new DataView(bytes.buffer, 7, 7);

	assert.deepStrictEqual(await got.post('', {body}).json(), {body: 'payload', length: '7'});
});

test('DataView request bodies preserve arbitrary bytes', withServer, async (_t, server, got) => {
	server.post('/', (request, response) => {
		request.pipe(response);
	});
	const bytes = new Uint8Array([0, 127, 128, 255]);

	assert.deepStrictEqual(await got.post('', {body: new DataView(bytes.buffer)}).buffer(), bytes);
});

test('empty DataView request bodies have zero content length', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.json({body: await getStream(request), length: request.headers['content-length']});
	});
	const bytes = new Uint8Array([1, 2, 3]);

	assert.deepStrictEqual(await got.post('', {body: new DataView(bytes.buffer, 1, 0)}).json(), {body: '', length: '0'});
});

test('DataView request bodies honor explicit chunked transfer encoding', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		assert.strictEqual(request.headers['content-length'], undefined);
		assert.strictEqual(request.headers['transfer-encoding'], 'chunked');
		response.end(await getStream(request));
	});
	const bytes = new TextEncoder().encode('payload');

	assert.strictEqual(await got.post('', {body: new DataView(bytes.buffer), headers: {'transfer-encoding': 'chunked'}}).text(), 'payload');
});

test('DataView request bodies can be replayed on retry', withServer, async (_t, server, got) => {
	const receivedBodies: string[] = [];
	server.post('/', async (request, response) => {
		receivedBodies.push(await getStream(request));
		response.statusCode = receivedBodies.length === 1 ? 503 : 200;
		response.end('done');
	});
	const bytes = new TextEncoder().encode('before:payload:after');

	assert.strictEqual(await got.post('', {
		body: new DataView(bytes.buffer, 7, 7),
		retry: {
			limit: 1, methods: ['POST'], backoffLimit: 0, noise: 0,
		},
	}).text(), 'done');
	assert.deepStrictEqual(receivedBodies, ['payload', 'payload']);
});

test('undefined retry options preserve retries configured by an extended instance', withServer, async (_t, server, got) => {
	let requests = 0;
	let delayCalls = 0;
	server.post('/', (_request, response) => {
		requests++;
		response.statusCode = requests === 1 ? 503 : 200;
		response.end('done');
	});
	const instance = got.extend({
		retry: {
			limit: 1,
			methods: ['POST'],
			statusCodes: [503],
			calculateDelay() {
				delayCalls++;
				return 1;
			},
		},
	});

	assert.strictEqual(await instance.post('', {
		retry: {
			methods: undefined, statusCodes: undefined, calculateDelay: undefined, limit: undefined,
		},
	}).text(), 'done');
	assert.strictEqual(requests, 2);
	assert.strictEqual(delayCalls, 1);
});

test('mutable defaults permit changing header arrays used by requests', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers['x-values']);
	});
	const instance = got.extend({mutableDefaults: true, headers: {'x-values': ['first']}});
	(instance.defaults.options.headers['x-values'] as string[]).push('second');

	assert.strictEqual(await instance('').text(), 'first, second');
});

test('request hooks can mutate header arrays cloned from immutable defaults', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers['x-values']);
	});
	const instance = got.extend({
		headers: {'x-values': ['first']},
		hooks: {
			beforeRequest: [options => {
				(options.headers['x-values'] as string[]).push('request');
			}],
		},
	});

	assert.strictEqual(await instance('').text(), 'first, request');
	assert.strictEqual(await instance('', {headers: {'x-values': ['override']}}).text(), 'override, request');
	assert.deepStrictEqual(instance.defaults.options.headers['x-values'], ['first']);
});

test('WebDAV methods are accepted without type assertions', withServer, async (_t, server, got) => {
	server.all('/', (request, response) => {
		response.end(request.method);
	});

	assert.strictEqual(await got('', {method: 'PROPFIND'}).text(), 'PROPFIND');
});

test('extended instances can retry custom methods', withServer, async (_t, server, got) => {
	let requests = 0;
	server.all('/', (request, response) => {
		requests++;
		response.statusCode = requests === 1 ? 503 : 200;
		response.end(request.method);
	});
	const instance = got.extend({
		method: 'report',
		retry: {
			limit: 1, methods: ['report'], backoffLimit: 0, noise: 0,
		},
	});

	assert.strictEqual(await instance('').text(), 'REPORT');
	assert.strictEqual(requests, 2);
});

test('invalid method tokens remain rejected by the native request', withServer, async (_t, server, got) => {
	let requests = 0;
	server.all('/', (_request, response) => {
		requests++;
		response.end();
	});

	await assert.rejects(got('', {method: 'INVALID METHOD', retry: {limit: 0}}), {code: 'ERR_INVALID_HTTP_TOKEN'});
	assert.strictEqual(requests, 0);
});

test('requestUrl preserves the original URL when a hook mutates the request URL in place', withServer, async (_t, server, got) => {
	server.get('/actual', (request, response) => {
		response.end(request.originalUrl);
	});

	const response = await got('original?initial=yes', {
		hooks: {
			beforeRequest: [options => {
				options.url!.pathname = '/actual';
				options.url!.searchParams.set('added', 'yes');
			}],
		},
	});

	assert.strictEqual(response.body, '/actual?initial=yes&added=yes');
	assert.strictEqual(response.url, `${server.url}/actual?initial=yes&added=yes`);
	assert.strictEqual(response.requestUrl.href, `${server.url}/original?initial=yes`);
});

test('stream requestUrl preserves its original URL through in-place hook changes', withServer, async (_t, server, got) => {
	server.get('/actual', echoUrl);

	const stream = got.stream('original?initial=yes', {
		hooks: {
			beforeRequest: [options => {
				options.url!.pathname = '/actual';
				options.url!.searchParams.delete('initial');
			}],
		},
	});

	assert.strictEqual(await getStream(stream), '/actual');
	assert.strictEqual(stream.requestUrl?.href, `${server.url}/original?initial=yes`);
	assert.strictEqual(stream.response?.requestUrl.href, `${server.url}/original?initial=yes`);
});

test('requestUrl preserves the URL from before hooks and redirects', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.redirect('/final');
	});
	server.get('/final', echoUrl);

	const response = await got('original', {
		hooks: {
			beforeRequest: [options => {
				if (options.url!.pathname === '/original') {
					options.url!.pathname = '/redirect';
				}
			}],
		},
	});

	assert.strictEqual(response.body, '/final');
	assert.strictEqual(response.url, `${server.url}/final`);
	assert.strictEqual(response.requestUrl.href, `${server.url}/original`);
	assert.deepStrictEqual(response.redirectUrls.map(url => url.href), [`${server.url}/final`]);
});

test('requestUrl snapshots normalized options without mutating the input URL', withServer, async (_t, server, got) => {
	server.get('/original', echoUrl);

	const input = new URL(`${server.url}/original?initial=yes`);
	const response = await got(input, {searchParams: {normalized: 'yes'}});

	assert.strictEqual(response.body, '/original?normalized=yes');
	assert.strictEqual(response.requestUrl.href, `${server.url}/original?normalized=yes`);
	assert.strictEqual(input.href, `${server.url}/original?initial=yes`);
	assert.notStrictEqual(response.requestUrl, input);
	assert.notStrictEqual(response.requestUrl, response.request.options.url);
});

test('createConnection can provide its socket asynchronously through the callback', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('connected');
	});

	let connections = 0;
	const response = await got('', {
		createConnection(_options, callback) {
			setImmediate(() => {
				connections++;
				callback(null, connect({host: 'localhost', port: Number(new URL(server.url).port)}));
			});
		},
	});

	assert.strictEqual(response.body, 'connected');
	assert.strictEqual(connections, 1);
});

test('createConnection can report a connection error without a socket', withServer, async (_t, _server, got) => {
	const cause = new Error('Connection setup failed');
	const error = await rejects(got('', {
		retry: {limit: 0},
		createConnection(_options, callback) {
			setImmediate(() => {
				callback(cause);
			});
		},
	}), {message: cause.message});

	assert.strictEqual(error?.cause, cause);
});

for (const useCallback of [false, true]) {
	test(`createConnection supports synchronous socket creation with callback ${useCallback}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('connected');
		});

		let connections = 0;
		const response = await got('', {
			createConnection(_options, callback) {
				connections++;
				const socket = connect({host: 'localhost', port: Number(new URL(server.url).port)});
				if (useCallback) {
					callback(null, socket);
					return;
				}

				return socket;
			},
		});

		assert.strictEqual(response.body, 'connected');
		assert.strictEqual(connections, 1);
	});
}

test('beforeCache receives response headers and status before Got metadata exists', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('cache-control', 'public, max-age=60');
		response.end('cached body');
	});

	let hookCalls = 0;
	const response = await got('', {
		cache: new Map(),
		hooks: {
			beforeCache: [response => {
				hookCalls++;
				assert.strictEqual(response.statusCode, 200);
				assert.strictEqual(response.headers['cache-control'], 'public, max-age=60');
				// @ts-expect-error Got request metadata is not available before caching.
				assert.strictEqual(typeof response.request, 'undefined');
				// @ts-expect-error Got request metadata is not available before caching.
				assert.strictEqual(typeof response.requestUrl, 'undefined');
				// @ts-expect-error The success flag is added after cache hooks run.
				assert.strictEqual(typeof response.ok, 'undefined');
			}],
		},
	});

	assert.strictEqual(hookCalls, 1);
	assert.strictEqual(response.body, 'cached body');
});

test('beforeCache supports typed header and status mutations used by the cache', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.end('cached body');
	});

	let hookCalls = 0;
	const instance = got.extend({
		cache: new Map(),
		hooks: {
			beforeCache: [response => {
				hookCalls++;
				response.headers['cache-control'] = 'public, max-age=60';
				response.headers['x-cached'] = 'yes';
				response.statusCode = 203;
				response.statusMessage = 'Custom status';
			}],
		},
	});

	const first = await instance('');
	const cached = await instance('');

	assert.strictEqual(first.body, 'cached body');
	assert.strictEqual(cached.body, 'cached body');
	assert.strictEqual(cached.isFromCache, true);
	assert.strictEqual(cached.headers['x-cached'], 'yes');
	assert.strictEqual(cached.statusCode, 203);
	assert.strictEqual(first.statusMessage, 'Custom status');
	assert.strictEqual(requests, 1);
	assert.strictEqual(hookCalls, 1);
});

test('beforeRequest accepts a native ClientRequest return value', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers['x-native']);
	});

	const response = await got('', {
		hooks: {
			beforeRequest: [options => httpRequest(options.url!, {headers: {'x-native': 'request'}})],
		},
	});

	assert.strictEqual(response.body, 'request');
	assert.strictEqual(response.statusCode, 200);
});

test('beforeRequest accepts a native IncomingMessage return value', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.headers['x-native']);
	});

	const response = await got('', {
		hooks: {
			beforeRequest: [async options => new Promise<IncomingMessage>((resolve, reject) => {
				httpGet(options.url!, {headers: {'x-native': 'response'}}, resolve).once('error', reject);
			})],
		},
	});

	assert.strictEqual(response.body, 'response');
	assert.strictEqual(response.statusCode, 200);
});

test('async native request hooks support streaming uploads and skip remaining hooks', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});

	const request = got.stream.post('', {
		body: 'streamed payload',
		hooks: {
			beforeRequest: [
				async options => httpRequest(options.url!, {method: 'POST'}),
				() => {
					assert.fail('Remaining hooks must be skipped after a native request is returned');
				},
			],
		},
	});

	assert.strictEqual(await getStream(request), 'streamed payload');
});

test('synchronous native response hooks preserve response data and skip transport', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/native', (_request, response) => {
		requests++;
		response.statusCode = 202;
		response.setHeader('x-source', 'native');
		response.end('accepted');
	});
	const nativeResponse = await new Promise<IncomingMessage>((resolve, reject) => {
		httpGet(`${server.url}/native`, resolve).once('error', reject);
	});

	const response = await got('unused', {
		hooks: {
			beforeRequest: [() => nativeResponse],
		},
	});

	assert.strictEqual(response.statusCode, 202);
	assert.strictEqual(response.headers['x-source'], 'native');
	assert.strictEqual(response.body, 'accepted');
	assert.strictEqual(requests, 1);
});

test('init hook primitive failures retain their original message and request options', async _t => {
	const error = await rejects(got('https://example.com', {
		hooks: {
			init: [() => {
				throw 'Initialization failed'; // eslint-disable-line @typescript-eslint/only-throw-error
			}],
		},
	}), errorMatching(RequestError, {message: 'Initialization failed'}));

	assert.strictEqual(error.options instanceof Options, true);
	assert.strictEqual(error.options.url!.toString(), 'https://example.com/');
	assert.strictEqual((error.cause as Error).message, 'Initialization failed');
});

for (const value of [undefined, null, 42, false]) {
	test(`init hooks normalize thrown ${String(value)}`, async _t => {
		const error = await rejects(got('https://example.com', {
			hooks: {
				init: [() => {
					throw value; // eslint-disable-line @typescript-eslint/only-throw-error
				}],
			},
		}), errorMatching(RequestError, {message: String(value)}));

		assert.strictEqual(error.options instanceof Options, true);
	});
}

test('init hook error objects keep their metadata without mutating the thrown object', async _t => {
	const original = Object.freeze({message: 'Initialization rejected', code: 'ERR_CUSTOM_INIT', input: 'bad value'});
	const error = await rejects(got('https://example.com', {
		hooks: {
			init: [() => {
				throw original; // eslint-disable-line @typescript-eslint/only-throw-error
			}],
		},
	}), errorMatching(RequestError, {message: original.message, code: original.code}));

	assert.strictEqual(error.input, original.input);
	assert.strictEqual((error.cause as Error).cause, original);
	assert.strictEqual(Object.hasOwn(original, 'options'), false);
});

test('ordinary init errors remain the request error cause', async _t => {
	const original = new TypeError('Invalid configuration');
	const error = await rejects(got('https://example.com', {
		hooks: {
			init: [() => {
				throw original;
			}],
		},
	}), errorMatching(RequestError, {message: original.message}));

	assert.strictEqual(error.cause, original);
	assert.strictEqual(error.options instanceof Options, true);
});

test('stream requests expose normalized init failures', async _t => {
	const request = got.stream('https://example.com', {
		hooks: {
			init: [() => {
				throw 'Stream initialization failed'; // eslint-disable-line @typescript-eslint/only-throw-error
			}],
		},
	});

	const error = await rejects(getStream(request), errorMatching(RequestError, {message: 'Stream initialization failed'}));

	assert.strictEqual(error.options, request.options);
	assert.strictEqual(request.destroyed, true);
});

test('Options construction normalizes objects without an error message', _t => {
	const original = {reason: 'Invalid configuration'};
	const error = throws(() => new Options('https://example.com', {
		hooks: {
			init: [() => {
				throw original; // eslint-disable-line @typescript-eslint/only-throw-error
			}],
		},
	}), {
		message: 'Non-error object thrown',
	});

	assert.strictEqual(error.cause, original);
	assert.strictEqual(Object.hasOwn(original, 'options'), false);
});

test('init hook thrown object with a cause field preserves the full error chain', async _t => {
	const innerError = new Error('root cause');
	const thrown = {message: 'init failed', cause: innerError};
	const error = await rejects(got('https://example.com', {
		hooks: {
			init: [() => {
				throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error
			}],
		},
	}), errorMatching(RequestError, {message: 'init failed'}));

	// The normalizeError wrapper holds the thrown object as its own cause.
	const normalizedCause = error.cause as Error & {cause: typeof thrown};
	assert.strictEqual(normalizedCause.message, 'init failed');
	assert.strictEqual(normalizedCause.cause, thrown);
	assert.strictEqual(normalizedCause.cause.cause, innerError);
});

// The `body`, `json` and `form` options are documented as never being merged with the
// instance defaults.
for (const [name, extendOptions] of [
	['body', {body: 'from-defaults'}],
	['json', {json: {leaked: true}}],
	['form', {form: {leaked: '1'}}],
] as Array<[string, Record<string, unknown>]>) {
	test(`an instance ${name} option is not merged into its requests`, withServer, async (_t, server, got) => {
		let receivedBody: string | undefined;
		let receivedType: string | undefined;
		server.post('/a', (request, response) => {
			receivedBody = '';
			request.on('data', chunk => {
				receivedBody += chunk as string;
			});
			request.on('end', () => {
				receivedType = request.headers['content-type'];
				response.end('ok');
			});
		});

		const instance = got.extend({prefixUrl: server.url, ...extendOptions});

		await instance.post('a');
		assert.strictEqual(receivedBody, '');
		assert.strictEqual(receivedType, undefined);

		await instance.post('a', {body: 'explicit'});
		assert.strictEqual(receivedBody, 'explicit');
	});
}
