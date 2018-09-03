import {URL, URLSearchParams} from 'url';
import test from 'ava';
import pEvent from 'p-event';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	const echoUrl = (request, response) => {
		response.end(request.url);
	};

	s.on('/', (request, response) => {
		response.statusCode = 404;
		response.end();
	});

	s.on('/test', echoUrl);
	s.on('/?test=wow', echoUrl);
	s.on('/test/foobar', echoUrl);
	s.on('/?test=it’s+ok', echoUrl);
	s.on('/?test=http://example.com?foo=bar', echoUrl);

	s.on('/stream', (request, response) => {
		response.end('ok');
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('url is required', async t => {
	const error = await t.throwsAsync(got());
	t.regex(error.message, /Parameter `url` must be a string or object, not undefined/);
});

test('url should be utf-8 encoded', async t => {
	const error = await t.throwsAsync(got(`${s.url}/%D2%E0%EB%EB%E8%ED`));
	t.regex(error.message, /Parameter `url` must contain valid UTF-8 character sequences/);
});

test('string url with query is preserved', async t => {
	const path = '/?test=http://example.com?foo=bar';
	const response = await got(`${s.url}${path}`);
	t.is(response.body, path);
});

test('options are optional', async t => {
	t.is((await got(`${s.url}/test`)).body, '/test');
});

test('methods are normalized', async t => {
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

	await instance(`${s.url}/test`, {method: 'post'});
});

test('accepts url.parse object as first argument', async t => {
	t.is((await got({
		hostname: s.host,
		port: s.port,
		path: '/test'
	})).body, '/test');
});

test('requestUrl with url.parse object as first argument', async t => {
	t.is((await got({
		hostname: s.host,
		port: s.port,
		path: '/test'
	})).requestUrl, `${s.url}/test`);
});

test('overrides querystring from opts', async t => {
	const response = await got(
		`${s.url}/?drop=this`,
		{
			query: {test: 'wow'},
			cache: {
				get(key) {
					t.is(key, `cacheable-request:GET:${s.url}/?test=wow`);
				},
				set(key) {
					t.is(key, `cacheable-request:GET:${s.url}/?test=wow`);
				}
			}
		}
	);
	t.is(response.body, '/?test=wow');
});

test('escapes query parameter values', async t => {
	const response = await got(`${s.url}`, {
		query: {
			test: 'it’s ok'
		}
	});
	t.is(response.body, '/?test=it%E2%80%99s+ok');
});

test('the `query` option can be a URLSearchParams', async t => {
	const query = new URLSearchParams({test: 'wow'});
	const {body} = await got(s.url, {query});
	t.is(body, '/?test=wow');
});

test('should ignore empty query object', async t => {
	t.is((await got(`${s.url}/test`, {query: {}})).requestUrl, `${s.url}/test`);
});

test('should throw with auth in url string', async t => {
	const error = await t.throwsAsync(got('https://test:45d3ps453@account.myservice.com/api/token'));
	t.regex(error.message, /Basic authentication must be done with the `auth` option/);
});

test('does not throw with auth in url object', async t => {
	await t.notThrowsAsync(got({
		auth: 'foo:bar',
		hostname: s.host,
		port: s.port,
		path: '/test'
	}));
});

test('should throw when body is set to object', async t => {
	await t.throwsAsync(got(`${s.url}/`, {body: {}}), TypeError);
});

test('WHATWG URL support', async t => {
	const wURL = new URL(`${s.url}/test`);
	await t.notThrowsAsync(got(wURL));
});

test('should return streams when using stream option', async t => {
	const data = await pEvent(got(`${s.url}/stream`, {stream: true}), 'data');
	t.is(data.toString(), 'ok');
});

test('should ignore JSON option when using stream option', async t => {
	const data = await pEvent(got(`${s.url}/stream`, {stream: true, json: true}), 'data');
	t.is(data.toString(), 'ok');
});

test('throws TypeError when `url` is passed as an option', async t => {
	await t.throwsAsync(got('', {url: 'example.com'}), {instanceOf: TypeError});
	await t.throwsAsync(got({url: 'example.com'}), {instanceOf: TypeError});
});

test('throws TypeError when `hooks` is not an object', async t => {
	await t.throwsAsync(
		() => got(s.url, {hooks: 'not object'}),
		{
			instanceOf: TypeError,
			message: 'Parameter `hooks` must be an object, not string'
		}
	);
});

test('throws TypeError when known `hooks` value is not an array', async t => {
	await t.throwsAsync(
		() => got(s.url, {hooks: {beforeRequest: {}}}),
		{
			instanceOf: TypeError,
			message: 'Parameter `hooks.beforeRequest` must be an array, not Object'
		}
	);
});

test('throws TypeError when known `hooks` array item is not a function', async t => {
	await t.throwsAsync(
		() => got(s.url, {hooks: {beforeRequest: [{}]}}),
		{
			instanceOf: TypeError,
			message: 'Parameter `hooks.beforeRequest[0]` must be a function, not Object'
		}
	);
});

test('allows extra keys in `hooks`', async t => {
	await t.notThrowsAsync(() => got(`${s.url}/test`, {hooks: {extra: {}}}));
});

test('baseUrl works', async t => {
	const instanceA = got.extend({baseUrl: `${s.url}/test`});
	const {body} = await instanceA('/foobar');
	t.is(body, '/test/foobar');
});

test('accepts WHATWG URL as the baseUrl option', async t => {
	const instanceA = got.extend({baseUrl: new URL(`${s.url}/test`)});
	const {body} = await instanceA('/foobar');
	t.is(body, '/test/foobar');
});

test('backslash in the end of `baseUrl` is optional', async t => {
	const instanceA = got.extend({baseUrl: `${s.url}/test/`});
	const {body} = await instanceA('/foobar');
	t.is(body, '/test/foobar');
});

test('backslash in the beginning of `url` is optional when using baseUrl', async t => {
	const instanceA = got.extend({baseUrl: `${s.url}/test`});
	const {body} = await instanceA('foobar');
	t.is(body, '/test/foobar');
});

test('throws when trying to modify baseUrl after options got normalized', async t => {
	const instanceA = got.create({
		methods: [],
		options: {baseUrl: 'https://example.com'},
		handler: options => {
			options.baseUrl = 'https://google.com';
		}
	});

	await t.throwsAsync(instanceA('/'), 'Failed to set baseUrl. Options are normalized already.');
});
