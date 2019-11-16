import net = require('net');
import {AddressInfo} from 'net';
import test from 'ava';
import toughCookie = require('tough-cookie');
import delay = require('delay');
import got from '../source';
import withServer from './helpers/with-server';

test('reads a cookie', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({cookieJar});

	const cookie = cookieJar.getCookiesSync(server.url)[0];
	t.is(cookie.key, 'hello');
	t.is(cookie.value, 'world');
});

test('reads multiple cookies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({cookieJar});

	const cookies = cookieJar.getCookiesSync(server.url);
	const cookieA = cookies[0];
	t.is(cookieA.key, 'hello');
	t.is(cookieA.value, 'world');

	const cookieB = cookies[1];
	t.is(cookieB.key, 'foo');
	t.is(cookieB.value, 'bar');
});

test('cookies doesn\'t break on redirects', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.setHeader('location', '/');
		response.statusCode = 302;
		response.end();
	});

	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? '');
	});

	const cookieJar = new toughCookie.CookieJar();

	const {body} = await got('redirect', {cookieJar});
	t.is(body, 'hello=world; foo=bar');
});

test('throws on invalid cookies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world; domain=localhost');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await t.throwsAsync(got({cookieJar}), 'Cookie has domain set to a public suffix');
});

test('does not throw on invalid cookies when options.ignoreInvalidCookies is set', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world; domain=localhost');
		response.end();
	});

	const cookieJar = new toughCookie.CookieJar();

	await got({
		cookieJar,
		ignoreInvalidCookies: true
	});

	const cookies = cookieJar.getCookiesSync(server.url);
	t.is(cookies.length, 0);
});

test('catches store errors', async t => {
	const error = 'Some error';
	// @ts-ignore
	const cookieJar = new toughCookie.CookieJar({
		findCookies: (_, __, cb) => {
			cb(new Error(error), []);
		}
	});

	await t.throwsAsync(got('https://example.com', {cookieJar}), error);
});

test('overrides options.headers.cookie', withServer, async (t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.setHeader('location', '/');
		response.statusCode = 302;
		response.end();
	});

	server.get('/', (request, response) => {
		response.end(request.headers.cookie ?? '');
	});

	const cookieJar = new toughCookie.CookieJar();
	const {body} = await got('redirect', {
		cookieJar,
		headers: {
			cookie: 'a=b'
		}
	});
	t.is(body, 'hello=world; foo=bar');
});

test('no unhandled errors', async t => {
	const server = net.createServer(connection => {
		connection.end('blah');
	}).listen(0);

	const message = 'snap!';

	const options = {
		cookieJar: {
			setCookie: async (_rawCookie, _url) => {},
			getCookieString: async _url => {
				throw new Error(message);
			}
		}
	};

	// @ts-ignore Manual tests
	await t.throwsAsync(got(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, options), {message});
	await delay(500);
	t.pass();

	server.close();
});

test('accepts custom `cookieJar` object', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.setHeader('set-cookie', ['hello=world']);
		response.end(request.headers.cookie);
	});

	const cookies = {};
	const cookieJar = {
		async getCookieString(url) {
			t.is(typeof url, 'string');

			return cookies[url];
		},

		async setCookie(rawCookie, url) {
			cookies[url] = rawCookie;
		}
	};

	const first = await got('', {cookieJar});
	const second = await got('', {cookieJar});

	t.is(first.body, '');
	t.is(second.body, 'hello=world');
});

test('throws on invalid `options.cookieJar.setCookie`', async t => {
	await t.throwsAsync(got('https://example.com', {
		cookieJar: {
			// @ts-ignore
			setCookie: () => {}
		}
	}), '`options.cookieJar.setCookie` needs to be an async function with 2 arguments');
});

test('throws on invalid `options.cookieJar.getCookieString`', async t => {
	await t.throwsAsync(got('https://example.com', {
		cookieJar: {
			setCookie: async (_rawCookie, _url) => {},
			// @ts-ignore
			getCookieString: () => {}
		}
	}), '`options.cookieJar.getCookieString` needs to be an async function with 1 argument');
});
