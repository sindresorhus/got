import net from 'net';
import test from 'ava';
import tough from 'tough-cookie';
import delay from 'delay';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/set-cookie', (request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	s.on('/set-multiple-cookies', (request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.end();
	});

	s.on('/set-cookies-then-redirect', (request, response) => {
		response.setHeader('set-cookie', ['hello=world', 'foo=bar']);
		response.setHeader('location', '/');
		response.statusCode = 302;
		response.end();
	});

	s.on('/invalid', (request, response) => {
		response.setHeader('set-cookie', 'hello=world; domain=localhost');
		response.end();
	});

	s.on('/', (request, response) => {
		response.end(request.headers.cookie || '');
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('reads a cookie', async t => {
	const cookieJar = new tough.CookieJar();

	await got(`${s.url}/set-cookie`, {cookieJar});

	const cookie = cookieJar.getCookiesSync(s.url)[0];
	t.is(cookie.key, 'hello');
	t.is(cookie.value, 'world');
});

test('reads multiple cookies', async t => {
	const cookieJar = new tough.CookieJar();

	await got(`${s.url}/set-multiple-cookies`, {cookieJar});

	const cookies = cookieJar.getCookiesSync(s.url);
	const cookieA = cookies[0];
	t.is(cookieA.key, 'hello');
	t.is(cookieA.value, 'world');

	const cookieB = cookies[1];
	t.is(cookieB.key, 'foo');
	t.is(cookieB.value, 'bar');
});

test('cookies doesn\'t break on redirects', async t => {
	const cookieJar = new tough.CookieJar();

	const {body} = await got(`${s.url}/set-cookies-then-redirect`, {cookieJar});
	t.is(body, 'hello=world; foo=bar');
});

test('throws on invalid cookies', async t => {
	const cookieJar = new tough.CookieJar();

	await t.throwsAsync(() => got(`${s.url}/invalid`, {cookieJar}), 'Cookie has domain set to a public suffix');
});

test('catches store errors', async t => {
	const error = 'Some error';
	const cookieJar = new tough.CookieJar({
		findCookies: (_, __, cb) => {
			cb(new Error(error));
		}
	});

	await t.throwsAsync(() => got(s.url, {cookieJar}), error);
});

test('overrides options.headers.cookie', async t => {
	const cookieJar = new tough.CookieJar();
	const {body} = await got(`${s.url}/set-cookies-then-redirect`, {
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
			setCookie: () => {},
			getCookieString: (_, __, cb) => cb(new Error(message))
		}
	};

	// @ts-ignore
	await t.throwsAsync(got(`http://127.0.0.1:${server.address().port}`, options), {message});
	await delay(500);
	t.pass();

	server.close();
});
