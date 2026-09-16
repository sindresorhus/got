import test from 'ava';
import {CookieJar} from 'tough-cookie';
import withServer from './helpers/with-server.js';

test('retry does not resend a cookie expired by the previous response', withServer, async (t, server, got) => {
	const cookieJar = new CookieJar();
	await cookieJar.setCookie('session=old; Path=/', server.url);
	const cookies: Array<string | undefined> = [];
	server.get('/', (request, response) => {
		cookies.push(request.headers.cookie);
		if (cookies.length === 1) {
			response.writeHead(503, {'set-cookie': 'session=deleted; Max-Age=0; Path=/'}).end();
			return;
		}

		response.end('done');
	});

	await got('', {cookieJar, retry: {limit: 1, backoffLimit: 0, noise: 0}});

	t.deepEqual(cookies, ['session=old', undefined]);
});

for (const statusCode of [302, 307]) {
	test(`a ${statusCode} redirect does not resend a cookie expired by the previous response`, withServer, async (t, server, got) => {
		const cookieJar = new CookieJar();
		await cookieJar.setCookie('session=old; Path=/', server.url);
		const cookies: Array<string | undefined> = [];
		server.use((request, response) => {
			cookies.push(request.headers.cookie);
			if (cookies.length === 1) {
				response.writeHead(statusCode, {location: '/next', 'set-cookie': 'session=deleted; Max-Age=0; Path=/'}).end();
				return;
			}

			response.end('done');
		});

		await got('', {cookieJar});

		t.deepEqual(cookies, ['session=old', undefined]);
	});
}

for (const cookie of ['explicit=value', '', undefined]) {
	test(`an empty cookie jar preserves an explicit Cookie value of ${JSON.stringify(cookie)}`, withServer, async (t, server, got) => {
		const cookies: Array<string | undefined> = [];
		server.get('/', (request, response) => {
			cookies.push(request.headers.cookie);
			response.writeHead(cookies.length === 1 ? 503 : 200).end('done');
		});

		await got('', {
			cookieJar: new CookieJar(),
			headers: {cookie},
			retry: {limit: 1, backoffLimit: 0, noise: 0},
		});

		t.deepEqual(cookies, [cookie, cookie]);
	});
}
