import test from 'ava';
import withServer from './helpers/with-server.js';

for (const headerName of ['cookie', 'Cookie', 'COOKIE']) {
	for (const cookie of ['session=new', '', undefined]) {
		test(`pagination applies ${headerName}: ${JSON.stringify(cookie)}`, withServer, async (t, server, got) => {
			const receivedCookies: Array<string | undefined> = [];
			server.get('/', (request, response) => {
				receivedCookies.push(request.headers.cookie);
				response.end(JSON.stringify([receivedCookies.length]));
			});

			const items = await got.paginate.all<number>('', {
				headers: {
					cookie: 'session=old',
				},
				pagination: {
					requestLimit: 2,
					paginate: () => ({
						headers: {
							[headerName]: cookie,
						},
					}),
				},
			});

			t.deepEqual(items, [1, 2]);
			t.deepEqual(receivedCookies, ['session=old', cookie]);
		});
	}
}

test('pagination preserves a case-insensitive cookie override when removing the cookie jar', withServer, async (t, server, got) => {
	const receivedCookies: Array<string | undefined> = [];
	server.get('/', (request, response) => {
		receivedCookies.push(request.headers.cookie);
		response.end(JSON.stringify([receivedCookies.length]));
	});

	const items = await got.paginate.all<number>('', {
		cookieJar: {
			async getCookieString() {
				return 'session=from-jar';
			},
			async setCookie() {},
		},
		pagination: {
			requestLimit: 2,
			paginate: () => ({
				cookieJar: undefined,
				headers: {
					// eslint-disable-next-line @typescript-eslint/naming-convention
					Cookie: 'session=new',
				},
			}),
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(receivedCookies, ['session=from-jar', 'session=new']);
});
