import {Buffer} from 'node:buffer';
import test from 'ava';
import delay from 'delay';
import getStream from 'get-stream';
import got, {type Response} from '../source/index.js';
import withServer, {withBodyParsingServer} from './helpers/with-server.js';
import type {ExtendedHttpTestServer} from './helpers/create-http-test-server.js';

const thrower = (): any => {
	throw new Error('This should not be called');
};

const resetPagination = {
	paginate: undefined,
	transform: undefined,
	filter: undefined,
	shouldContinue: undefined,
};

const createStaticCookieJar = (cookie = 'session=from-jar') => ({
	async getCookieString() {
		return cookie;
	},
	async setCookie() {},
});

// eslint-disable-next-line unicorn/no-object-as-default-parameter
const attachHandler = (server: ExtendedHttpTestServer, count: number, {relative} = {relative: false}): void => {
	server.get('/', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParameters.get('page')) || 1;

		if (page < count) {
			response.setHeader('link', `<${relative ? '' : server.url}/?page=${page + 1}>; rel="next"`);
		}

		response.end(`[${page <= count ? page : ''}]`);
	});
};

const createCrossOriginPaginationReceiver = async (responseBody = '[]') => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;
	const server = await createHttpTestServer({bodyParser: false});
	const received = {
		authorization: undefined as string | undefined,
		cookie: undefined as string | undefined,
		body: '',
		contentType: undefined as string | undefined,
	};

	server.post('/items', async (request, response) => {
		received.authorization = request.headers.authorization;
		received.cookie = request.headers.cookie;
		received.body = await getStream(request);
		received.contentType = request.headers['content-type'];
		response.end(responseBody);
	});

	server.get('/items', (request, response) => {
		received.authorization = request.headers.authorization;
		received.cookie = request.headers.cookie;
		received.contentType = request.headers['content-type'];
		response.end(responseBody);
	});

	return {server, received};
};

const createPaginationSourceServer = async (responseBody = '[1]') => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;
	const server = await createHttpTestServer();
	server.get('/items', (_request, response) => {
		response.end(responseBody);
	});

	server.post('/items', (_request, response) => {
		response.end(responseBody);
	});

	return server;
};

const createRetryUrlServer = async (retryUrl: string) => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;
	const server = await createHttpTestServer();

	server.get('/api', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retryUrl}));
	});

	return server;
};

test('the link header has no next value', withServer, async (t, server, got) => {
	const items = [1];

	server.get('/', (_request, response) => {
		response.setHeader('link', '<https://example.com>; rel="prev"');
		response.end(JSON.stringify(items));
	});

	const received = await got.paginate.all<number>('');
	t.deepEqual(received, items);
});

test('the link header is empty', withServer, async (t, server, got) => {
	const items = [1];

	server.get('/', (_request, response) => {
		response.setHeader('link', '');
		response.end(JSON.stringify(items));
	});

	const received = await got.paginate.all<number>('');
	t.deepEqual(received, items);
});

test('retrieves all elements', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.paginate.all<number>('');

	t.deepEqual(result, [1, 2]);
});

test('retrieves all elements with JSON responseType', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend({
		responseType: 'json',
	}).paginate.all<number>('');

	t.deepEqual(result, [1, 2]);
});

test('preserves URL credentials for relative next-page links', withServer, async (t, server, got) => {
	const expectedAuthorization = `Basic ${Buffer.from('hello:world').toString('base64')}`;

	server.get('/', (request, response) => {
		if (request.headers.authorization !== expectedAuthorization) {
			response.statusCode = 401;
			response.end('Unauthorized');
			return;
		}

		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParameters.get('page')) || 1;

		if (page < 2) {
			response.setHeader('link', '</?page=2>; rel="next"');
		}

		response.end(`[${page}]`);
	});

	const url = new URL(server.url);
	url.username = 'hello';
	url.password = 'world';

	const result = await got.paginate.all<number>(url);

	t.deepEqual(result, [1, 2]);
});

test('points to defaults when extending Got without custom `pagination`', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend().paginate.all<number>('');

	t.deepEqual(result, [1, 2]);
});

test('pagination options can be extended', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend({
		pagination: {
			shouldContinue: () => false,
		},
	}).paginate.all<number>('');

	t.deepEqual(result, []);
});

test('filters elements', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			filter({item, currentItems, allItems}) {
				t.true(Array.isArray(allItems));
				t.true(Array.isArray(currentItems));

				return item !== 2;
			},
		},
	});

	t.deepEqual(result, [1, 3]);
});

test('parses elements', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all<number, string>('?page=100', {
		pagination: {
			transform: response => [response.body.length],
		},
	});

	t.deepEqual(result, [5]);
});

test('parses elements - async function', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all<number, string>('?page=100', {
		pagination: {
			transform: async response => [response.body.length],
		},
	});

	t.deepEqual(result, [5]);
});

test('custom paginate function', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate({response}) {
				const url = new URL(response.url);

				if (url.search === '?page=3') {
					return false;
				}

				url.search = '?page=3';

				return {url};
			},
		},
	});

	t.deepEqual(result, [1, 3]);
});

test('custom paginate function using allItems', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate({allItems, response}) {
				if (allItems.length === 2) {
					return false;
				}

				return {
					url: new URL('/?page=3', response.url),
				};
			},
			stackAllItems: true,
		},
	});

	t.deepEqual(result, [1, 3]);
});

test('custom paginate function using currentItems', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate({currentItems, response}) {
				if (currentItems[0] === 3) {
					return false;
				}

				return {
					url: new URL('/?page=3', response.url),
				};
			},
		},
	});

	t.deepEqual(result, [1, 3]);
});

test('iterator works', withServer, async (t, server, got) => {
	attachHandler(server, 5);

	const results = await Array.fromAsync(got.paginate<number>(''));

	t.deepEqual(results, [1, 2, 3, 4, 5]);
});

test('iterator works #2', withServer, async (t, server, got) => {
	attachHandler(server, 5);

	const results = await Array.fromAsync(got.paginate.each<number>(''));

	t.deepEqual(results, [1, 2, 3, 4, 5]);
});

test('`shouldContinue` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		pagination: {
			shouldContinue({currentItems, allItems}: {allItems: number[]; currentItems: number[]}) {
				t.true(Array.isArray(allItems));
				t.true(Array.isArray(currentItems));

				return false;
			},
		},
	};

	const results = await Array.fromAsync(got.paginate<number>(options));

	t.deepEqual(results, []);
});

test('`countLimit` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		pagination: {
			countLimit: 1,
		},
	};

	const results = await Array.fromAsync(got.paginate<number>(options));

	t.deepEqual(results, [1]);
});

test('throws if the `pagination` option does not have `transform` property', async t => {
	const iterator = got.paginate('', {
		pagination: {...resetPagination},
		prefixUrl: 'https://example.com',
	});

	await t.throwsAsync(iterator.next());
});

test('throws if the `pagination` option does not have `shouldContinue` property', async t => {
	const iterator = got.paginate('', {
		pagination: {
			...resetPagination,
			transform: thrower,
		},
		prefixUrl: 'https://example.com',
	});

	await t.throwsAsync(iterator.next());
});

test('throws if the `pagination` option does not have `filter` property', async t => {
	const iterator = got.paginate('', {
		pagination: {
			...resetPagination,
			transform: thrower,
			shouldContinue: thrower,
			paginate: thrower,
		},
		prefixUrl: 'https://example.com',
	});

	await t.throwsAsync(iterator.next());
});

test('throws if the `pagination` option does not have `paginate` property', async t => {
	const iterator = got.paginate('', {
		pagination: {
			...resetPagination,
			transform: thrower,
			shouldContinue: thrower,
			filter: thrower,
		},
		prefixUrl: 'https://example.com',
	});

	await t.throwsAsync(iterator.next());
});

test('ignores the `resolveBodyOnly` option', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const items = await got.paginate.all('', {
		resolveBodyOnly: true,
	});

	t.deepEqual(items, [1, 2]);
});

test('allowGetBody sends json payload with .paginate()', withBodyParsingServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.body.hello !== 'world') {
			response.statusCode = 400;
		}

		response.end(JSON.stringify([1, 2, 3]));
	});

	const iterator = got.paginate<number>({
		allowGetBody: true,
		json: {hello: 'world'},
		retry: {
			limit: 0,
		},
	});

	const results = await Array.fromAsync(iterator);

	t.deepEqual(results, [1, 2, 3]);
});

test('`hooks` are not duplicated', withServer, async (t, server, got) => {
	let page = 1;
	server.get('/', (_request, response) => {
		response.end(JSON.stringify([page++]));
	});

	const nopHook = () => {};

	const result = await got.paginate.all<number>({
		pagination: {
			paginate({response}) {
				if ((response.body as string) === '[3]') {
					return false; // Stop after page 3
				}

				const {options} = response.request;
				const {init, beforeRequest, beforeRedirect, beforeRetry, afterResponse, beforeError} = options.hooks;
				const hooksCount = [init, beforeRequest, beforeRedirect, beforeRetry, afterResponse, beforeError].map(a => a.length);

				t.deepEqual(hooksCount, [1, 1, 1, 1, 1, 1]);

				return options;
			},
		},
		hooks: {
			init: [nopHook],
			beforeRequest: [nopHook],
			beforeRedirect: [nopHook],
			beforeRetry: [nopHook],
			afterResponse: [response => response],
			beforeError: [error => error],
		},
	});

	t.deepEqual(result, [1, 2, 3]);
});

test('allowGetBody sends correct json payload with .paginate()', withServer, async (t, server, got) => {
	let page = 1;
	server.get('/', async (request, response) => {
		const payload = await getStream(request);

		try {
			JSON.parse(payload);
		} catch {
			response.statusCode = 422;
		}

		if (request.headers['content-length']) {
			t.is(Number(request.headers['content-length'] || 0), Buffer.byteLength(payload));
		} else {
			t.pass();
		}

		response.end(JSON.stringify([page++]));
	});

	let body = '';

	const iterator = got.paginate<number>({
		allowGetBody: true,
		retry: {
			limit: 0,
		},
		json: {body},
		pagination: {
			paginate() {
				if (body.length === 2) {
					return false;
				}

				body += 'a';

				return {
					json: {body},
				};
			},
		},
	});

	const results = await Array.fromAsync(iterator);

	t.deepEqual(results, [1, 2, 3]);
});

test('`requestLimit` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		pagination: {
			requestLimit: 1,
		},
	};

	const results = await Array.fromAsync(got.paginate<number>(options));

	t.deepEqual(results, [1]);
});

test('`backoff` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const backoff = 200;

	const asyncIterator: AsyncIterator<number> = got.paginate<number>('', {
		pagination: {
			backoff,
		},
	});

	t.is((await asyncIterator.next()).value, 1);

	let receivedLastOne = false;
	const start = Date.now();
	const promise = asyncIterator.next();
	(async () => {
		await promise;
		receivedLastOne = true;
	})();

	await delay(backoff / 2);
	t.false(receivedLastOne);

	await promise;
	t.true(Date.now() - start >= backoff);
});

test('`stackAllItems` set to true', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	let itemCount = 0;
	const result = await got.paginate.all<number>({
		pagination: {
			stackAllItems: true,
			filter({allItems}) {
				t.is(allItems.length, itemCount);

				return true;
			},
			shouldContinue({allItems}) {
				t.is(allItems.length, itemCount);

				return true;
			},
			paginate({response, currentItems, allItems}) {
				itemCount += 1;
				t.is(allItems.length, itemCount);

				return got.defaults.options.pagination.paginate!({response, currentItems, allItems});
			},
		},
	});

	t.deepEqual(result, [1, 2, 3]);
});

test('`stackAllItems` set to false', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			stackAllItems: false,
			filter({allItems}) {
				t.is(allItems.length, 0);

				return true;
			},
			shouldContinue({allItems}) {
				t.is(allItems.length, 0);

				return true;
			},
			paginate({response, currentItems, allItems}) {
				t.is(allItems.length, 0);

				return got.defaults.options.pagination.paginate!({response, allItems, currentItems});
			},
		},
	});

	t.deepEqual(result, [1, 2, 3]);
});

test('next url in json response', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);

		response.end(JSON.stringify({
			currentUrl: request.url,
			next: page < 3 ? `${server.url}/?page=${page + 1}` : undefined,
		}));
	});

	type Page = {
		currentUrl: string;
		next?: string;
	};

	const all = await got.paginate.all('', {
		searchParams: {
			page: 0,
		},
		responseType: 'json',
		pagination: {
			transform: (response: Response<Page>) => [response.body.currentUrl],
			paginate({response}) {
				const {next} = response.body;

				if (!next) {
					return false;
				}

				return {
					url: new URL(next),
					prefixUrl: '',
					searchParams: undefined,
				};
			},
		},
	});

	t.deepEqual(all, [
		'/?page=0',
		'/?page=1',
		'/?page=2',
		'/?page=3',
	]);
});

test('pagination using searchParams', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);

		response.end(JSON.stringify({
			currentUrl: request.url,
			next: page < 3,
		}));
	});

	type Page = {
		currentUrl: string;
		next?: string;
	};

	const all = await got.paginate.all('', {
		searchParams: {
			page: 0,
		},
		responseType: 'json',
		pagination: {
			transform: (response: Response<Page>) => [response.body.currentUrl],
			paginate({response}) {
				const {next} = response.body;
				// eslint-disable-next-line unicorn/prevent-abbreviations
				const searchParams = response.request.options.searchParams as URLSearchParams;
				const previousPage = Number(searchParams.get('page'));

				if (!next) {
					return false;
				}

				return {
					searchParams: {
						page: previousPage + 1,
					},
				};
			},
		},
	});

	t.deepEqual(all, [
		'/?page=0',
		'/?page=1',
		'/?page=2',
		'/?page=3',
	]);
});

test('pagination using extended searchParams', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);

		response.end(JSON.stringify({
			currentUrl: request.url,
			next: page < 3,
		}));
	});

	type Page = {
		currentUrl: string;
		next?: string;
	};

	const client = got.extend({
		searchParams: {
			limit: 10,
		},
	});

	const all = await client.paginate.all('', {
		searchParams: {
			page: 0,
		},
		responseType: 'json',
		pagination: {
			transform: (response: Response<Page>) => [response.body.currentUrl],
			paginate({response}) {
				const {next} = response.body;
				// eslint-disable-next-line unicorn/prevent-abbreviations
				const searchParams = response.request.options.searchParams as URLSearchParams;
				const previousPage = Number(searchParams.get('page'));

				if (!next) {
					return false;
				}

				return {
					searchParams: {
						page: previousPage + 1,
					},
				};
			},
		},
	});

	t.is(all.length, 4);

	for (let i = 0; i < 4; i++) {
		t.true(all[i] === `/?page=${i}&limit=10` || all[i] === `/?limit=10&page=${i}`);
	}
});

test('calls init hooks on pagination', withServer, async (t, server) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify([request.url]));
	});

	const instance = got.extend({
		hooks: {
			init: [
				options => {
					options.searchParams = 'foobar';
				},
			],
		},
	});

	const received = await instance.paginate.all<string>(server.url, {
		searchParams: 'unicorn',
	});

	t.deepEqual(received, [
		'/?foobar=',
	]);
});

test('retrieves all elements - relative url', withServer, async (t, server, got) => {
	attachHandler(server, 2, {relative: true});

	const result = await got.paginate.all<number>('');

	t.deepEqual(result, [1, 2]);
});

test('throws when `url` is passed in pagination options object', async t => {
	await t.throwsAsync(got.paginate.all<number>({url: 'https://example.com'} as any), {
		instanceOf: TypeError,
		message: 'The `url` option is not supported in options objects. Pass it as the first argument instead.',
	});
});

test('throws when `url` is passed in pagination second argument options object', async t => {
	await t.throwsAsync(got.paginate.all<number>('https://example.com', {url: 'https://example.com'} as any), {
		instanceOf: TypeError,
		message: 'The `url` option is not supported in options objects. Pass it as the first argument instead.',
	});
});

test('throws if url is neither a string nor a URL', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	await t.throwsAsync(got.paginate.all<number>('', {
		pagination: {
			paginate: () => ({
				url: 1 as any,
			}),
		},
	}), {
		instanceOf: TypeError,
	});
});

test('throws when transform does not return an array', withServer, async (t, server) => {
	server.get('/', (_request, response) => {
		response.end(JSON.stringify(''));
	});

	await t.throwsAsync(got.paginate.all<string>(server.url), {
		instanceOf: TypeError,
	});
});

test('strips sensitive headers when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/steal', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.setHeader('link', `<${evilServer.url}/steal>; rel="next"`);
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		headers: {
			authorization: 'Bearer SECRET',
		},
		pagination: {
			requestLimit: 2,
		},
	});

	t.deepEqual(items, [1]);
	t.is(evilReceivedAuth, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('strips cookie header when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedCookie: string | undefined;
	evilServer.get('/steal', (request, response) => {
		evilReceivedCookie = request.headers.cookie;
		response.end('[]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.setHeader('link', `<${evilServer.url}/steal>; rel="next"`);
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		headers: {
			cookie: 'session=SECRET',
		},
		pagination: {
			requestLimit: 2,
		},
	});

	t.deepEqual(items, [1]);
	t.is(evilReceivedCookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves explicit authorization when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[2]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		headers: {
			authorization: 'Bearer SECRET',
		},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL(evilServer.url + '/items'),
						headers: {
							authorization: 'Bearer NEW',
						},
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(evilReceivedAuth, 'Bearer NEW');

	await trustedServer.close();
	await evilServer.close();
});

test('preserves explicit basic auth when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[2]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		username: 'old-user',
		password: 'old-password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL(evilServer.url + '/items'),
						username: 'new-user',
						password: 'new-password',
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(evilReceivedAuth, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves explicit URL object credentials when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[2]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const nextUrl = new URL(response.request.options.url!);
					nextUrl.protocol = 'http:';
					nextUrl.hostname = 'localhost';
					nextUrl.port = String(evilServer.port);
					nextUrl.pathname = '/items';
					return {url: nextUrl};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(evilReceivedAuth, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves explicit URL object username when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[2]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		username: 'user',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const nextUrl = new URL(response.request.options.url!);
					nextUrl.protocol = 'http:';
					nextUrl.hostname = 'localhost';
					nextUrl.port = String(evilServer.port);
					nextUrl.pathname = '/items';
					return {url: nextUrl};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(evilReceivedAuth, `Basic ${Buffer.from('user:').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('strips inherited password when explicit URL object keeps only username during pagination cross-origin navigation', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[2]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const nextUrl = new URL(response.request.options.url!);
					nextUrl.protocol = 'http:';
					nextUrl.hostname = 'localhost';
					nextUrl.port = String(evilServer.port);
					nextUrl.pathname = '/items';
					nextUrl.password = '';
					return {url: nextUrl};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(evilReceivedAuth, `Basic ${Buffer.from('user:').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves same-value credentials on replacement url when pagination navigates cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver('[2]');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/items`);

	const items = await got.paginate.all(trustedServer.url + '/api', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			transform(response) {
				const body = JSON.parse(response.body as string);
				return 'retryUrl' in body ? [] : body;
			},
			paginate({response}) {
				const body = JSON.parse(response.body as string);
				if (body.retryUrl) {
					return {
						url: `http://user:password@localhost:${new URL(body.retryUrl).port}/items`,
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [2]);
	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('supports string url values when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer();
	let evilReceivedAuth: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		response.end('[2]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all(trustedServer.url + '/items', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: `${evilServer.url}/items`,
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(evilReceivedAuth, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('supports relative string url values when pagination navigates', withServer, async (t, server, got) => {
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParameters.get('page')) || 1;
		response.end(JSON.stringify([page]));
	});

	const items = await got.paginate.all<number>('items?page=1', {
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/items?page=1')) {
					return {url: '?page=2'};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
});

test('supports path-relative string url values when pagination navigates', withServer, async (t, server, got) => {
	server.get('/items/start', (_request, response) => {
		response.end(JSON.stringify([1]));
	});

	server.get('/items/next', (_request, response) => {
		response.end(JSON.stringify([2]));
	});

	const items = await got.paginate.all<number>('items/start', {
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/items/start')) {
					return {url: 'next'};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
});

test('preserves explicit credentials with relative string url values when pagination navigates', withServer, async (t, server, got) => {
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParameters.get('page')) || 1;

		if (page === 1) {
			response.end(JSON.stringify([1]));
			return;
		}

		response.end(JSON.stringify([request.headers.authorization]));
	});

	const items = await got.paginate.all<string | number>('items?page=1', {
		username: 'old-user',
		password: 'old-password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/items?page=1')) {
					return {
						url: '?page=2',
						username: 'new-user',
						password: 'new-password',
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`]);
});

test('preserves explicit credentials with path-relative string url values when pagination navigates', withServer, async (t, server, got) => {
	server.get('/items/start', (_request, response) => {
		response.end(JSON.stringify([1]));
	});

	server.get('/items/next', (request, response) => {
		response.end(JSON.stringify([request.headers.authorization]));
	});

	const items = await got.paginate.all<string | number>('items/start', {
		username: 'old-user',
		password: 'old-password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/items/start')) {
					return {
						url: 'next',
						username: 'new-user',
						password: 'new-password',
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`]);
});

test('preserves explicit credentials with query-only string url values when pagination navigates', withServer, async (t, server, got) => {
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParameters.get('page')) || 1;

		if (page === 1) {
			response.end(JSON.stringify([1]));
			return;
		}

		response.end(JSON.stringify([request.headers.authorization]));
	});

	const items = await got.paginate.all<string | number>('items?page=1', {
		username: 'old-user',
		password: 'old-password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/items?page=1')) {
					return {
						url: '?page=2',
						username: 'new-user',
						password: 'new-password',
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`]);
});

test('supports parent-relative string url values with query params when pagination navigates', withServer, async (t, server, got) => {
	server.get('/nested/items/start', (_request, response) => {
		response.end(JSON.stringify([1]));
	});

	server.get('/nested/target', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		response.end(JSON.stringify([Number(searchParameters.get('page'))]));
	});

	const items = await got.paginate.all<number>('nested/items/start', {
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/nested/items/start')) {
					return {url: '../target?page=2'};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
});

test('supports scheme-relative string url values when pagination navigates', withServer, async (t, server, got) => {
	server.get('/items/start', (_request, response) => {
		response.end(JSON.stringify([1]));
	});

	server.get('/scheme-relative', (_request, response) => {
		response.end(JSON.stringify([2]));
	});

	const items = await got.paginate.all<number>('items/start', {
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (String(response.requestUrl).endsWith('/items/start')) {
					return {url: `//localhost:${server.port}/scheme-relative`};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
});

test('preserves explicit credentials with string url values when pagination navigates cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver('[2]');
	const trustedServer = await createRetryUrlServer(`${evilServer.url}/items`);

	const items = await got.paginate.all(trustedServer.url + '/api', {
		username: 'old-user',
		password: 'old-password',
		headers: {
			cookie: 'session=secret',
		},
		pagination: {
			requestLimit: 2,
			transform(response) {
				const body = JSON.parse(response.body as string);
				return 'retryUrl' in body ? [] : body;
			},
			paginate({response}) {
				const body = JSON.parse(response.body as string);
				if (body.retryUrl) {
					return {
						url: body.retryUrl,
						username: 'new-user',
						password: 'new-password',
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [2]);
	t.is(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);
	t.is(received.cookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('drops body when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer({bodyParser: false});
	let evilReceivedBody = '';
	let evilReceivedContentLength: string | undefined;
	let evilReceivedContentType: string | undefined;
	evilServer.post('/items', async (request, response) => {
		evilReceivedBody = await getStream(request);
		evilReceivedContentLength = request.headers['content-length'];
		evilReceivedContentType = request.headers['content-type'];
		response.end('[]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.post('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		method: 'POST',
		json: {secret: 'payload'},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL(evilServer.url + '/items'),
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(evilReceivedBody, '');
	t.is(evilReceivedContentLength, '0');
	t.is(evilReceivedContentType, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('removes explicit undefined headers when pagination navigates cross-origin', async t => {
	const createHttpTestServer = (await import('./helpers/create-http-test-server.js')).default;

	const evilServer = await createHttpTestServer({bodyParser: false});
	let evilReceivedAuth: string | undefined;
	let evilReceivedCookie: string | undefined;
	evilServer.get('/items', (request, response) => {
		evilReceivedAuth = request.headers.authorization;
		evilReceivedCookie = request.headers.cookie;
		response.end('[]');
	});

	const trustedServer = await createHttpTestServer();
	trustedServer.get('/items', (_request, response) => {
		response.end('[1]');
	});

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		headers: {
			authorization: 'Bearer OLD',
			cookie: 'session=abc',
		},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL(evilServer.url + '/items'),
						headers: {
							authorization: undefined,
							cookie: undefined,
						},
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(evilReceivedAuth, undefined);
	t.is(evilReceivedCookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('strips sensitive headers and body when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		method: 'POST',
		headers: {
			authorization: 'Bearer OLD',
			cookie: 'session=abc',
			'content-type': 'text/plain',
		},
		body: 'payload',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, undefined);
	t.is(received.cookie, undefined);
	t.is(received.body, '');
	t.is(received.contentType, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves body when pagination stays same-origin', withServer, async (t, server, got) => {
	const payloads: string[] = [];
	server.post('/items', async (request, response) => {
		payloads.push(await getStream(request));
		const currentPage = payloads.length;

		if (currentPage < 2) {
			response.end(JSON.stringify([currentPage]));
			return;
		}

		response.end(JSON.stringify([currentPage]));
	});

	const items = await got.paginate.all<number>('items', {
		method: 'POST',
		json: {secret: 'payload'},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL('/items?page=2', response.url),
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(payloads.map(payload => JSON.parse(payload).secret), ['payload', 'payload']);
});

test('pagination can explicitly omit generated authorization on the next page', withServer, async (t, server, got) => {
	let finalAuthorization: string | undefined;
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '2') {
			finalAuthorization = request.headers.authorization;
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL('/items?page=2', response.url),
						headers: {
							authorization: undefined,
						},
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(finalAuthorization, undefined);
});

test('pagination can explicitly omit generated cookieJar cookies on the next page', withServer, async (t, server, got) => {
	let finalCookie: string | undefined;
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '2') {
			finalCookie = request.headers.cookie;
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL('/items?page=2', response.url),
						headers: {
							cookie: undefined,
						},
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(finalCookie, undefined);
});

test('pagination clears stale generated cookie when cookieJar is removed on the next page', withServer, async (t, server, got) => {
	let finalCookie: string | undefined;
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '2') {
			finalCookie = request.headers.cookie;
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL('/items?page=2', response.url),
						cookieJar: undefined,
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(finalCookie, undefined);
});

test('pagination preserves explicit cookie when disabling cookieJar on the next page', withServer, async (t, server, got) => {
	let finalCookie: string | undefined;
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '2') {
			finalCookie = request.headers.cookie;
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL('/items?page=2', response.url),
						cookieJar: undefined,
						headers: {
							cookie: 'session=from-jar',
						},
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(finalCookie, 'session=from-jar');
});

test('pagination clears stale generated cookie when reusing mutated options and removing cookieJar on the next page', withServer, async (t, server, got) => {
	let finalCookie: string | undefined;
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '2') {
			finalCookie = request.headers.cookie;
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL('/items?page=2', response.url);
					updatedOptions.cookieJar = undefined;
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(finalCookie, undefined);
});

test('pagination restores generated cookies after temporarily removing cookieJar on reused options', withServer, async (t, server, got) => {
	let finalCookie: string | undefined;
	server.get('/items', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '3') {
			finalCookie = request.headers.cookie;
			response.end('[3]');
			return;
		}

		if (page === '2') {
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 3,
			paginate({response}) {
				const updatedOptions = response.request.options;

				if (response.body === '[1]') {
					updatedOptions.url = new URL('/items?page=2', response.url);
					updatedOptions.cookieJar = undefined;
					return updatedOptions;
				}

				if (response.body === '[2]') {
					updatedOptions.url = new URL('/items?page=3', response.url);
					updatedOptions.cookieJar = createStaticCookieJar('session=from-new-jar');
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2, 3]);
	t.is(finalCookie, 'session=from-new-jar');
});

test('pagination clears stale generated cookie when switching from reused options back to merged options', withServer, async (t, server, got) => {
	const receivedCookies: string[] = [];
	server.get('/items', (request, response) => {
		receivedCookies.push(request.headers.cookie ?? '');
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '3') {
			response.end('[3]');
			return;
		}

		if (page === '2') {
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 3,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL('/items?page=2', response.url);
					return updatedOptions;
				}

				if (response.body === '[2]') {
					return {
						url: new URL('/items?page=3', response.url),
						cookieJar: undefined,
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2, 3]);
	t.deepEqual(receivedCookies, ['session=from-jar', 'session=from-jar', '']);
});

test('pagination ignores discarded cookie mutations when disabling cookieJar with merged options', withServer, async (t, server, got) => {
	const receivedCookies: string[] = [];
	server.get('/items', (request, response) => {
		receivedCookies.push(request.headers.cookie ?? '');
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = searchParameters.get('page');

		if (page === '2') {
			response.end('[2]');
			return;
		}

		response.end('[1]');
	});

	const items = await got.paginate.all<number>('items?page=1', {
		cookieJar: createStaticCookieJar(),
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				response.request.options.headers.cookie = 'session=discarded';
				return {
					url: new URL('/items?page=2', response.url),
					cookieJar: undefined,
				};
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(receivedCookies, ['session=from-jar', '']);
});

test('preserves explicit replacement body when pagination navigates cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver('[2]');
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		method: 'POST',
		json: {secret: 'old-payload'},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					return {
						url: new URL(evilServer.url + '/items'),
						json: {secret: 'new-payload'},
					};
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1, 2]);
	t.is(JSON.parse(received.body).secret, 'new-payload');
	t.is(received.contentType, 'application/json');

	await trustedServer.close();
	await evilServer.close();
});

test('preserves in-place body rewrite when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		method: 'POST',
		body: Buffer.from('old-payload'),
		headers: {
			'content-type': 'text/plain',
		},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					(updatedOptions.body as Uint8Array).set(Buffer.from('new-payload'));
					updatedOptions.headers['content-type'] = 'text/plain';
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.body, 'new-payload');
	t.is(received.contentType, 'text/plain');

	await trustedServer.close();
	await evilServer.close();
});

test('preserves explicit overrides when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		method: 'POST',
		headers: {
			authorization: 'Bearer old-secret',
			'content-type': 'text/plain',
		},
		body: 'old-payload',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					updatedOptions.headers.authorization = 'Bearer new-secret';
					updatedOptions.body = 'new-payload';
					updatedOptions.headers['content-type'] = 'text/plain';
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, 'Bearer new-secret');
	t.is(received.body, 'new-payload');
	t.is(received.contentType, 'text/plain');

	await trustedServer.close();
	await evilServer.close();
});

test('strips sensitive headers after headers object reassignment when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		headers: {
			authorization: 'Bearer secret',
			cookie: 'session=abc',
		},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					updatedOptions.headers = {
						...updatedOptions.headers,
						foo: 'bar',
					};
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, undefined);
	t.is(received.cookie, undefined);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves same-value authorization and body when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		method: 'POST',
		headers: {
			authorization: 'Bearer secret',
			'content-type': 'text/plain',
		},
		body: 'payload',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					updatedOptions.headers.authorization = 'Bearer secret';
					updatedOptions.body = 'payload';
					updatedOptions.headers['content-type'] = 'text/plain';
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, 'Bearer secret');
	t.is(received.body, 'payload');
	t.is(received.contentType, 'text/plain');

	await trustedServer.close();
	await evilServer.close();
});

test('preserves explicit replacement credentials when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		username: 'old-user',
		password: 'old-password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					updatedOptions.username = 'new-user';
					updatedOptions.password = 'new-password';
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, `Basic ${Buffer.from('new-user:new-password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves same-value credentials when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					updatedOptions.username = 'user';
					updatedOptions.password = 'password';
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('preserves URL object credentials when pagination reuses mutated request options cross-origin', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					updatedOptions.url = new URL(evilServer.url + '/items');
					updatedOptions.url.username = 'user';
					updatedOptions.url.password = 'password';
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`);

	await trustedServer.close();
	await evilServer.close();
});

test('strips inherited url credentials after in-place cross-origin url mutation when pagination reuses request options', async t => {
	const {server: evilServer, received} = await createCrossOriginPaginationReceiver();
	const trustedServer = await createPaginationSourceServer();

	const items = await got.paginate.all<number>(trustedServer.url + '/items', {
		username: 'user',
		password: 'password',
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				if (response.body === '[1]') {
					const updatedOptions = response.request.options;
					const nextUrl = new URL(evilServer.url + '/items');
					const currentUrl = updatedOptions.url as URL;
					currentUrl.hostname = nextUrl.hostname;
					currentUrl.port = nextUrl.port;
					currentUrl.pathname = nextUrl.pathname;
					currentUrl.protocol = nextUrl.protocol;
					return updatedOptions;
				}

				return false;
			},
		},
	});

	t.deepEqual(items, [1]);
	t.is(received.authorization, undefined);

	await trustedServer.close();
	await evilServer.close();
});
