import test from 'ava';
import {CookieJar} from 'tough-cookie';
import got, {Options} from '../source/index.js';
import withServer from './helpers/with-server.js';

test('a request can disable cookies without creating a child instance', withServer, async (t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new CookieJar();
	cookieJar.setCookieSync('session=value', server.url);
	const instance = client.extend({cookieJar});

	t.is(await instance('', {cookieJar: undefined}).text(), 'no-cookie');
});

test('resetting the jar preserves an explicit Cookie header', withServer, async (t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new CookieJar();
	cookieJar.setCookieSync('session=jar', server.url);
	const instance = client.extend({cookieJar});

	t.is(await instance('', {cookieJar: undefined, headers: {cookie: 'session=explicit'}}).text(), 'session=explicit');
});

test('direct merge resets an already normalized cookie jar', t => {
	const options = new Options('https://example.com/', {cookieJar: new CookieJar()});
	options.merge({cookieJar: undefined});

	t.is(options.cookieJar, undefined);
	t.is(options.url?.toString(), 'https://example.com/');
});

test('omitting cookieJar from request options preserves inherited cookies', withServer, async (t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new CookieJar();
	cookieJar.setCookieSync('session=value', server.url);
	const instance = client.extend({cookieJar});

	t.is(await instance('', {headers: {'x-test': 'unrelated'}}).text(), 'session=value');
});

test('a cookie jar reset survives replay when merging an instance', t => {
	const instance = got.extend({cookieJar: new CookieJar()}).extend({cookieJar: undefined});
	const replayed = got.extend(instance, {headers: {'x-test': 'unrelated'}});

	t.is(replayed.defaults.options.cookieJar, undefined);
});

test('a replacement jar works after a reset', withServer, async (t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const originalJar = new CookieJar();
	originalJar.setCookieSync('session=original', server.url);
	const replacementJar = new CookieJar();
	replacementJar.setCookieSync('session=replacement', server.url);
	const instance = client.extend({cookieJar: originalJar}).extend({cookieJar: undefined});

	t.is(await instance('', {cookieJar: replacementJar}).text(), 'session=replacement');
	t.is(instance.defaults.options.cookieJar, undefined);
});

test('a per-request reset does not disable cookies for later requests', withServer, async (t, server, client) => {
	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new CookieJar();
	cookieJar.setCookieSync('session=value', server.url);
	const instance = client.extend({cookieJar});

	await instance('', {cookieJar: undefined});
	t.is(instance.defaults.options.cookieJar, cookieJar);
	t.is(await instance('').text(), 'session=value');
});

test('a per-request reset does not store response cookies in the inherited jar', withServer, async (t, server, client) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'session=replaced; Path=/');
		response.end('ok');
	});

	const cookieJar = new CookieJar();
	cookieJar.setCookieSync('session=original; Path=/', server.url);
	const instance = client.extend({cookieJar});

	t.is(await instance('', {cookieJar: undefined}).text(), 'ok');
	t.is(cookieJar.getCookieStringSync(server.url), 'session=original');
});

test('a reset jar ignores invalid response cookies', withServer, async (t, server, client) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'invalid cookie; domain=localhost');
		response.end('ok');
	});

	const instance = client.extend({cookieJar: new CookieJar()});

	t.is(await instance('', {cookieJar: undefined}).text(), 'ok');
});

test('an init hook can supply an explicit cookie jar reset', t => {
	const defaults = new Options({cookieJar: new CookieJar()});
	const options = new Options('https://example.com/', {
		hooks: {
			init: [plainOptions => {
				plainOptions.cookieJar = undefined;
			}],
		},
	}, defaults);

	t.is(options.cookieJar, undefined);
});

test('explicit undefined resets an inherited cookie jar', t => {
	const cookieJar = new CookieJar();
	const defaults = new Options({cookieJar});
	const options = new Options('https://example.com/', {cookieJar: undefined}, defaults);

	t.is(options.cookieJar, undefined);
	t.is(defaults.cookieJar, cookieJar);
});

test('extending an instance can reset its cookie jar', t => {
	const cookieJar = new CookieJar();
	const parent = got.extend({cookieJar});
	const child = parent.extend({cookieJar: undefined});

	t.is(child.defaults.options.cookieJar, undefined);
	t.is(parent.defaults.options.cookieJar, cookieJar);
});

test('resetting the cookie jar removes cookies from subsequent requests', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('set-cookie', 'session=value; Path=/');
		response.end(request.headers.cookie ?? 'no-cookie');
	});
	server.get('/child', (request, response) => {
		response.setHeader('set-cookie', 'child=value; Path=/');
		response.end(request.headers.cookie ?? 'no-cookie');
	});

	const cookieJar = new CookieJar();
	const instance = got.extend({cookieJar});

	t.is(await instance('').text(), 'no-cookie');
	t.is(await instance('').text(), 'session=value');

	// The parent still uses the jar.
	t.is(await instance('').text(), 'session=value');

	const child = instance.extend({cookieJar: undefined});
	t.is(await child('child').text(), 'no-cookie');
	// The child stores nothing in the parent jar.
	t.deepEqual(cookieJar.getCookiesSync(server.url).map(cookie => cookie.cookieString()), ['session=value']);
	t.is(await child('child').text(), 'no-cookie');
	t.deepEqual(cookieJar.getCookiesSync(server.url).map(cookie => cookie.cookieString()), ['session=value']);
});
