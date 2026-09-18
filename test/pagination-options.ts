import {Buffer} from 'node:buffer';
import test from 'ava';
import ResponseLike from 'responselike';
import getStream from 'get-stream';
import got from '../source/index.js';
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

for (const responseType of ['text', 'buffer', 'json'] as const) {
	test(`pagination uses parseJson once for ${responseType} responses`, async t => {
		let calls = 0;
		const items = await got.paginate.all<string>('https://example.com/items', {
			responseType,
			parseJson(text) {
				calls++;
				t.is(text, '["original"]');
				return ['parsed'];
			},
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('["original"]'),
					url: 'https://example.com/items',
				})],
			},
		});

		t.deepEqual(items, ['parsed']);
		t.is(calls, 1);
	});
}

for (const responseType of ['text', 'buffer'] as const) {
	test(`pagination decodes and strips the BOM before custom parsing of ${responseType}`, async t => {
		const client = got.extend({
			responseType,
			encoding: 'utf16le',
			parseJson(text) {
				t.is(text, '["café"]');
				return ['custom'];
			},
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('﻿["café"]', 'utf16le'),
					url: 'https://example.com/items',
				})],
			},
		});

		t.deepEqual(await client.paginate.all<string>('https://example.com/items'), ['custom']);
	});

	test(`pagination propagates custom parser errors for ${responseType}`, async t => {
		const error = new Error('Custom parsing failed');
		await t.throwsAsync(got.paginate.all('https://example.com/items', {
			responseType,
			parseJson() {
				throw error;
			},
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('[]'),
					url: 'https://example.com/items',
				})],
			},
		}), {is: error});
	});
}

test('pagination stops at requestLimit without parsing an unused next-page link', async t => {
	const items = await got.paginate.all<number>('https://example.com', {
		pagination: {requestLimit: 1},
		hooks: {
			beforeRequest: [() => new ResponseLike({
				statusCode: 200,
				headers: {link: 'not a link'},
				body: Buffer.from('[1]'),
				url: 'https://example.com',
			})],
		},
	});

	t.deepEqual(items, [1]);
});

for (const requestLimit of [0, 1, 3]) {
	test(`pagination only computes needed next pages with requestLimit ${requestLimit}`, async t => {
		let requests = 0;
		let callbacks = 0;
		const items = await got.paginate.all<number>('https://example.com', {
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from(JSON.stringify([++requests])),
					url: 'https://example.com',
				})],
			},
			pagination: {
				requestLimit,
				paginate() {
					callbacks++;
					return {};
				},
			},
		});

		t.is(requests, requestLimit);
		t.is(items.length, requestLimit);
		t.is(callbacks, Math.max(0, requestLimit - 1));
	});
}

for (const responseType of ['text', 'buffer'] as const) {
	for (const leadingBom of [false, true]) {
		test(`pagination handles UTF-16LE ${responseType} responses with leading BOM ${leadingBom}`, withServer, async (t, server, got) => {
			server.get('/', (_request, response) => {
				const body = `${leadingBom ? '﻿' : ''}["café"]`;
				response.end(Buffer.from(body, 'utf16le'));
			});

			const items = await got.paginate.all<string>('', {encoding: 'utf16le', responseType});

			t.deepEqual(items, ['café']);
		});
	}

	test(`UTF-16LE ${responseType} pagination rejects a second leading BOM`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end(Buffer.from('﻿﻿["café"]', 'utf16le'));
		});

		await t.throwsAsync(got.paginate.all('', {encoding: 'utf16le', responseType}), {instanceOf: SyntaxError});
	});
}

test('UTF-16LE buffer pagination decodes each linked page', withServer, async (t, server, got) => {
	server.get('/first', (_request, response) => {
		response.setHeader('link', '</next>; rel="next"');
		response.end(Buffer.from('﻿["café"]', 'utf16le'));
	});
	server.get('/next', (_request, response) => {
		response.end(Buffer.from('﻿["世界"]', 'utf16le'));
	});

	const items = await got.paginate.all<string>('first', {encoding: 'utf16le', responseType: 'buffer'});

	t.deepEqual(items, ['café', '世界']);
});

test('pagination preserves custom content type when replacing a same-origin JSON body', withServer, async (t, server, got) => {
	const contentTypes: Array<string | undefined> = [];
	server.post('/', (request, response) => {
		contentTypes.push(request.headers['content-type']);
		request.resume();
		response.json([contentTypes.length]);
	});

	const items = await got.paginate.all<number>('', {
		method: 'POST',
		headers: {'content-type': 'application/vnd.api+json'},
		json: {page: 1},
		pagination: {
			requestLimit: 2,
			paginate: () => ({json: {page: 2}}),
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(contentTypes, ['application/vnd.api+json', 'application/vnd.api+json']);
});

test('pagination keeps default JSON content type when no explicit content type was set', withServer, async (t, server, got) => {
	const contentTypes: Array<string | undefined> = [];
	const bodies: string[] = [];
	server.post('/', async (request, response) => {
		contentTypes.push(request.headers['content-type']);
		bodies.push(await getStream(request));
		response.json([bodies.length]);
	});

	const items = await got.paginate.all<number>('', {
		method: 'POST',
		json: {page: 1},
		pagination: {
			requestLimit: 2,
			paginate: () => ({json: {page: 2}}),
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(contentTypes, ['application/json', 'application/json']);
	t.deepEqual(bodies, ['{"page":1}', '{"page":2}']);
});

test('pagination can override a custom content type while replacing the body', withServer, async (t, server, got) => {
	const contentTypes: Array<string | undefined> = [];
	server.post('/', (request, response) => {
		contentTypes.push(request.headers['content-type']);
		request.resume();
		response.json([contentTypes.length]);
	});

	const items = await got.paginate.all<number>('', {
		method: 'POST',
		headers: {'content-type': 'application/vnd.api+json'},
		json: {page: 1},
		pagination: {
			requestLimit: 2,
			paginate: () => ({body: 'page=2', headers: {'content-type': 'application/x-www-form-urlencoded'}}),
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(contentTypes, ['application/vnd.api+json', 'application/x-www-form-urlencoded']);
});

test('pagination keeps the explicit content type when replacing JSON with a string body', withServer, async (t, server, got) => {
	const contentTypes: Array<string | undefined> = [];
	server.post('/', (request, response) => {
		contentTypes.push(request.headers['content-type']);
		request.resume();
		response.json([contentTypes.length]);
	});

	const items = await got.paginate.all<number>('', {
		method: 'POST',
		headers: {'content-type': 'application/vnd.api+json'},
		json: {page: 1},
		pagination: {
			requestLimit: 2,
			paginate: () => ({body: 'page=2'}),
		},
	});

	t.deepEqual(items, [1, 2]);
	t.deepEqual(contentTypes, ['application/vnd.api+json', 'application/vnd.api+json']);
});

test('pagination applies explicit search parameters to the next URL', withServer, async (t, server, client) => {
	server.get('/first', (_request, response) => {
		response.json(['first']);
	});
	server.get('/next', (request, response) => {
		response.json([request.url]);
	});

	const items = await client.paginate.all<string>('first', {
		pagination: {
			requestLimit: 2,
			paginate: () => ({url: '/next', searchParams: {page: 2}}),
		},
	});

	t.deepEqual(items, ['first', '/next?page=2']);
});

test('pagination applies a URLSearchParams object to the next URL', withServer, async (t, server, client) => {
	server.get('/first', (_request, response) => {
		response.json(['first']);
	});
	server.get('/next', (request, response) => {
		response.json([request.url]);
	});

	const items = await client.paginate.all<string>('first', {
		pagination: {
			requestLimit: 2,
			paginate: () => ({url: '/next', searchParams: new URLSearchParams({page: '2'})}),
		},
	});

	t.deepEqual(items, ['first', '/next?page=2']);
});

test('pagination applies a searchParams string to the next URL', withServer, async (t, server, client) => {
	server.get('/first', (_request, response) => {
		response.json(['first']);
	});
	server.get('/next', (request, response) => {
		response.json([request.url]);
	});

	const items = await client.paginate.all<string>('first', {
		pagination: {
			requestLimit: 2,
			paginate: () => ({url: '/next', searchParams: 'page=2&limit=5'}),
		},
	});

	t.deepEqual(items, ['first', '/next?page=2&limit=5']);
});

test('pagination without a next url still applies search parameters', withServer, async (t, server, client) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);
		response.json([`/?page=${page}`]);
	});

	const items = await client.paginate.all<string>('', {
		searchParams: {page: 0},
		pagination: {
			requestLimit: 2,
			paginate({response}) {
				const searchParameters = response.request.options.searchParams as URLSearchParams;
				return {searchParams: {page: Number(searchParameters.get('page')) + 1}};
			},
		},
	});

	t.deepEqual(items, ['/?page=0', '/?page=1']);
});

test('pagination searchParams overrides the next URL query string', withServer, async (t, server, client) => {
	server.get('/first', (_request, response) => {
		response.json(['first']);
	});
	server.get('/next', (request, response) => {
		response.json([request.url]);
	});

	const items = await client.paginate.all<string>('first', {
		pagination: {
			requestLimit: 2,
			paginate: () => ({url: '/next?from=url', searchParams: {page: 2}}),
		},
	});

	t.deepEqual(items, ['first', '/next?page=2']);
});
