import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import createHttpTestServer from './helpers/create-http-test-server.js';

test('prefix-only pagination preserves a restrictive prefix and same-origin credentials', withServer, async (_t, server, got) => {
	const received: Array<{path: string; authorization: string | undefined}> = [];
	server.get(['/pages/', '/pages/next'], (request, response) => {
		received.push({path: request.url, authorization: request.headers.authorization});
		if (received.length === 1) {
			response.setHeader('link', '<next>; rel="next"');
		}

		response.json([received.length]);
	});
	const client = got.extend({prefixUrl: `${server.url}/pages/`, allowAbsoluteUrls: false, headers: {authorization: 'Bearer trusted'}});
	assert.deepStrictEqual(await client.paginate.all<number>(), [1, 2]);
	assert.deepStrictEqual(received, [{path: '/pages/', authorization: 'Bearer trusted'}, {path: '/pages/next', authorization: 'Bearer trusted'}]);
	assert.strictEqual(client.defaults.options.prefixUrl, `${server.url}/pages/`);
	assert.strictEqual(client.defaults.options.url, undefined);
});

test('prefix-only pagination preserves search parameters and merges page updates', withServer, async (_t, server, got) => {
	const paths: string[] = [];
	server.get('/pages/', (request, response) => {
		paths.push(request.url);
		response.json([Number(request.query.page)]);
	});
	const client = got.extend({prefixUrl: `${server.url}/pages/`, searchParams: {page: 1, token: 'a b'}});
	assert.deepStrictEqual(await client.paginate.all<number>({
		pagination: {
			requestLimit: 2,
			paginate: () => ({searchParams: {page: 2}}),
		},
	}), [1, 2]);
	assert.deepStrictEqual(paths, ['/pages/?page=1&token=a+b', '/pages/?token=a+b&page=2']);
	assert.strictEqual(client.defaults.options.searchParams.toString(), 'page=1&token=a+b');
});

test('prefix-only pagination keeps an explicit trusted credential after a cross-origin redirect', withServer, async (t, server, got) => {
	const target = await createHttpTestServer();
	t.after(target.close);
	const receivedAuthorizations: Array<string | undefined> = [];
	server.get('/pages/', (_request, response) => {
		response.redirect(`${target.url}/pages/`);
	});
	target.get(['/pages/', '/pages/next'], (request, response) => {
		receivedAuthorizations.push(request.headers.authorization);
		response.json([receivedAuthorizations.length]);
	});
	const client = got.extend({prefixUrl: `${server.url}/pages/`, headers: {authorization: 'Bearer original'}});
	assert.deepStrictEqual(await client.paginate.all<number>({
		pagination: {
			requestLimit: 2,
			paginate: () => ({url: `${target.url}/pages/next`, headers: {authorization: 'Bearer trusted'}}),
		},
	}), [1, 2]);
	assert.deepStrictEqual(receivedAuthorizations, [undefined, 'Bearer trusted']);
});

test('prefix-only pagination does not restore URL userinfo after a cross-origin redirect', withServer, async (t, server, got) => {
	const target = await createHttpTestServer();
	t.after(target.close);
	const receivedAuthorizations: Array<string | undefined> = [];
	server.get('/pages/', (_request, response) => {
		response.redirect(`${target.url}/pages/`);
	});
	target.get(['/pages/', '/pages/next'], (request, response) => {
		receivedAuthorizations.push(request.headers.authorization);
		if (receivedAuthorizations.length === 1) {
			response.setHeader('link', `<${target.url}/pages/next>; rel="next"`);
		}

		response.json([receivedAuthorizations.length]);
	});
	const prefixUrl = new URL(`${server.url}/pages/`);
	prefixUrl.username = 'user';
	prefixUrl.password = 'password';
	const client = got.extend({prefixUrl});
	assert.deepStrictEqual(await client.paginate.all<number>(), [1, 2]);
	assert.deepStrictEqual(receivedAuthorizations, [undefined, undefined]);
});
