import assert from 'node:assert/strict';
import getStream from 'get-stream';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import createHttpTestServer from './helpers/create-http-test-server.js';

for (const [reference, nextPath] of [['next', '/pages/next'], ['../next', '/next'], ['/next', '/next'], ['?page=2', '/pages/?page=2']] as const) {
	for (const api of ['all', 'each', 'options'] as const) {
		test(`prefix-only pagination resolves ${reference} through ${api}`, withServer, async (_t, server, got) => {
			const paths: string[] = [];
			server.get(['/pages/', '/pages/next', '/next'], (request, response) => {
				paths.push(request.url);
				if (paths.length === 1) {
					response.setHeader('link', `<${reference}>; rel="next"`);
					response.json([1]);
				} else {
					response.json([2]);
				}
			});
			const options = {prefixUrl: `${server.url}/pages/`, retry: {limit: 0}};
			const client = got.extend(options);
			let items: number[];
			if (api === 'options') {
				items = await got.paginate.all<number>(options);
			} else if (api === 'each') {
				items = await Array.fromAsync(client.paginate.each<number>());
			} else {
				items = await client.paginate.all<number>();
			}

			assert.deepStrictEqual(items, [1, 2]);
			assert.deepStrictEqual(paths, ['/pages/', nextPath]);
		});
	}
}

test('prefix-only pagination does not restore inherited headers after a cross-origin redirect', withServer, async (t, server, got) => {
	const target = await createHttpTestServer();
	t.after(target.close);
	const received: unknown[] = [];
	server.get('/pages/', (_request, response) => {
		response.redirect(`${target.url}/pages/`);
	});
	target.get(['/pages/', '/pages/next'], (request, response) => {
		received.push({
			authorization: request.headers.authorization, cookie: request.headers.cookie, cookie2: request.headers.cookie2, proxyAuthorization: request.headers['proxy-authorization'], host: request.headers.host,
		});
		if (received.length === 1) {
			response.setHeader('link', `<${target.url}/pages/next>; rel="next"`);
		}

		response.json([received.length]);
	});
	const headers = {
		authorization: 'Bearer secret', cookie: 'session=secret', cookie2: 'session=secret', 'proxy-authorization': 'Basic secret', host: 'original.test',
	};
	const client = got.extend({prefixUrl: `${server.url}/pages/`, headers, retry: {limit: 0}});
	assert.deepStrictEqual(await client.paginate.all<number>(), [1, 2]);
	const expectedHeaders = {
		authorization: undefined, cookie: undefined, cookie2: undefined, proxyAuthorization: undefined, host: new URL(target.url).host,
	};
	assert.deepStrictEqual(received, [expectedHeaders, expectedHeaders]);
});

test('prefix-only pagination does not restore a body removed by a cross-origin redirect', withServer, async (t, server, got) => {
	const target = await createHttpTestServer({bodyParser: false});
	t.after(target.close);
	const receivedBodies: string[] = [];
	server.get('/pages/', async (request, response) => {
		assert.strictEqual(await getStream(request), 'secret');
		response.redirect(`${target.url}/pages/`);
	});
	target.get(['/pages/', '/pages/next'], async (request, response) => {
		receivedBodies.push(await getStream(request));
		if (receivedBodies.length === 1) {
			response.setHeader('link', `<${target.url}/pages/next>; rel="next"`);
		}

		response.json([receivedBodies.length]);
	});
	assert.deepStrictEqual(await got.paginate.all<number>({
		prefixUrl: `${server.url}/pages/`, body: 'secret', allowGetBody: true, retry: {limit: 0},
	}), [1, 2]);
	assert.deepStrictEqual(receivedBodies, ['', '']);
});
