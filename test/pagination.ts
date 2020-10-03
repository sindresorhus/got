import {URL} from 'url';
import test from 'ava';
import delay = require('delay');
import getStream = require('get-stream');
import got, {Response} from '../source';
import withServer, {withBodyParsingServer} from './helpers/with-server';
import {ExtendedHttpTestServer} from './helpers/create-http-test-server';

const thrower = (): any => {
	throw new Error('This should not be called');
};

const resetPagination = {
	paginate: undefined,
	transform: undefined,
	filter: undefined,
	shouldContinue: undefined
};

const attachHandler = (server: ExtendedHttpTestServer, count: number): void => {
	server.get('/', (request, response) => {
		const searchParameters = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParameters.get('page')) || 1;

		if (page < count) {
			response.setHeader('link', `<${server.url}/?page=${page + 1}>; rel="next"`);
		}

		response.end(`[${page <= count ? page : ''}]`);
	});
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

test('retrieves all elements', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.paginate.all<number>('');

	t.deepEqual(result, [1, 2]);
});

test('retrieves all elements with JSON responseType', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend({
		responseType: 'json'
	}).paginate.all<number>('');

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
			shouldContinue: () => false
		}
	}).paginate.all<number>('');

	t.deepEqual(result, []);
});

test('filters elements', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			filter: (element: number, allItems: number[], currentItems: number[]) => {
				t.true(Array.isArray(allItems));
				t.true(Array.isArray(currentItems));

				return element !== 2;
			}
		}
	});

	t.deepEqual(result, [1, 3]);
});

test('parses elements', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all<number, string>('?page=100', {
		pagination: {
			transform: response => [response.body.length]
		}
	});

	t.deepEqual(result, [5]);
});

test('parses elements - async function', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all<number, string>('?page=100', {
		pagination: {
			transform: async response => [response.body.length]
		}
	});

	t.deepEqual(result, [5]);
});

test('custom paginate function', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate: response => {
				const url = new URL(response.url);

				if (url.search === '?page=3') {
					return false;
				}

				url.search = '?page=3';

				return {url};
			}
		}
	});

	t.deepEqual(result, [1, 3]);
});

test('custom paginate function using allItems', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate: (_response, allItems: number[]) => {
				if (allItems.length === 2) {
					return false;
				}

				return {path: '/?page=3'};
			}
		}
	});

	t.deepEqual(result, [1, 3]);
});

test('custom paginate function using currentItems', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate: (_response, _allItems: number[], currentItems: number[]) => {
				if (currentItems[0] === 3) {
					return false;
				}

				return {path: '/?page=3'};
			}
		}
	});

	t.deepEqual(result, [1, 3]);
});

test('iterator works', withServer, async (t, server, got) => {
	attachHandler(server, 5);

	const results: number[] = [];

	for await (const item of got.paginate<number>('')) {
		results.push(item);
	}

	t.deepEqual(results, [1, 2, 3, 4, 5]);
});

test('iterator works #2', withServer, async (t, server, got) => {
	attachHandler(server, 5);

	const results: number[] = [];

	for await (const item of got.paginate.each<number>('')) {
		results.push(item);
	}

	t.deepEqual(results, [1, 2, 3, 4, 5]);
});

test('`shouldContinue` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		pagination: {
			shouldContinue: (_item: unknown, allItems: unknown[], currentItems: unknown[]) => {
				t.true(Array.isArray(allItems));
				t.true(Array.isArray(currentItems));

				return false;
			}
		}
	};

	const results: number[] = [];

	for await (const item of got.paginate<number>(options)) {
		results.push(item);
	}

	t.deepEqual(results, []);
});

test('`countLimit` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		pagination: {
			countLimit: 1
		}
	};

	const results: number[] = [];

	for await (const item of got.paginate<number>(options)) {
		results.push(item);
	}

	t.deepEqual(results, [1]);
});

test('throws if no `pagination` option', async t => {
	const iterator = got.extend({
		pagination: false as any
	}).paginate('', {
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options.pagination` must be implemented'
	});
});

test('throws if the `pagination` option does not have `transform` property', async t => {
	const iterator = got.paginate('', {
		pagination: {...resetPagination},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options.pagination.transform` must be implemented'
	});
});

test('throws if the `pagination` option does not have `shouldContinue` property', async t => {
	const iterator = got.paginate('', {
		pagination: {
			...resetPagination,
			transform: thrower
		},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options.pagination.shouldContinue` must be implemented'
	});
});

test('throws if the `pagination` option does not have `filter` property', async t => {
	const iterator = got.paginate('', {
		pagination: {
			...resetPagination,
			transform: thrower,
			shouldContinue: thrower,
			paginate: thrower
		},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options.pagination.filter` must be implemented'
	});
});

test('throws if the `pagination` option does not have `paginate` property', async t => {
	const iterator = got.paginate('', {
		pagination: {
			...resetPagination,
			transform: thrower,
			shouldContinue: thrower,
			filter: thrower
		},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options.pagination.paginate` must be implemented'
	});
});

test('ignores the `resolveBodyOnly` option', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const items = await got.paginate.all('', {
		resolveBodyOnly: true
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
		retry: 0
	});

	const results: number[] = [];

	for await (const item of iterator) {
		results.push(item);
	}

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
			paginate: response => {
				if ((response.body as string) === '[3]') {
					return false; // Stop after page 3
				}

				const {options} = response.request;
				const {init, beforeRequest, beforeRedirect, beforeRetry, afterResponse, beforeError} = options.hooks;
				const hooksCount = [init, beforeRequest, beforeRedirect, beforeRetry, afterResponse, beforeError].map(a => a.length);

				t.deepEqual(hooksCount, [1, 1, 1, 1, 1, 1]);

				return options;
			}
		},
		hooks: {
			init: [nopHook],
			beforeRequest: [nopHook],
			beforeRedirect: [nopHook],
			beforeRetry: [nopHook],
			afterResponse: [response => response],
			beforeError: [error => error]
		}
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
		}

		response.end(JSON.stringify([page++]));
	});

	let body = '';

	const iterator = got.paginate<number>({
		allowGetBody: true,
		retry: 0,
		json: {body},
		pagination: {
			paginate: () => {
				if (body.length === 2) {
					return false;
				}

				body += 'a';

				return {
					json: {body}
				};
			}
		}
	});

	const results: number[] = [];

	for await (const item of iterator) {
		results.push(item);
	}

	t.deepEqual(results, [1, 2, 3]);
});

test('`requestLimit` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		pagination: {
			requestLimit: 1
		}
	};

	const results: number[] = [];

	for await (const item of got.paginate<number>(options)) {
		results.push(item);
	}

	t.deepEqual(results, [1]);
});

test('`backoff` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const backoff = 200;

	const asyncIterator: AsyncIterator<number> = got.paginate<number>('', {
		pagination: {
			backoff
		}
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
			filter: (_item, allItems, _currentItems) => {
				t.is(allItems.length, itemCount);

				return true;
			},
			shouldContinue: (_item, allItems, _currentItems) => {
				t.is(allItems.length, itemCount);

				return true;
			},
			paginate: (response, allItems, currentItems) => {
				itemCount += 1;
				t.is(allItems.length, itemCount);

				return got.defaults.options.pagination!.paginate(response, allItems, currentItems);
			}
		}
	});

	t.deepEqual(result, [1, 2, 3]);
});

test('`stackAllItems` set to false', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			stackAllItems: false,
			filter: (_item, allItems, _currentItems) => {
				t.is(allItems.length, 0);

				return true;
			},
			shouldContinue: (_item, allItems, _currentItems) => {
				t.is(allItems.length, 0);

				return true;
			},
			paginate: (response, allItems, currentItems) => {
				t.is(allItems.length, 0);

				return got.defaults.options.pagination!.paginate(response, allItems, currentItems);
			}
		}
	});

	t.deepEqual(result, [1, 2, 3]);
});

test('next url in json response', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);

		response.end(JSON.stringify({
			currentUrl: request.url,
			next: page < 3 ? `${server.url}/?page=${page + 1}` : undefined
		}));
	});

	interface Page {
		currentUrl: string;
		next?: string;
	}

	const all = await got.paginate.all('', {
		searchParams: {
			page: 0
		},
		responseType: 'json',
		pagination: {
			transform: (response: Response<Page>) => {
				return [response.body.currentUrl];
			},
			paginate: (response: Response<Page>) => {
				const {next} = response.body;

				if (!next) {
					return false;
				}

				return {
					url: next,
					prefixUrl: '',
					searchParams: undefined
				};
			}
		}
	});

	t.deepEqual(all, [
		'/?page=0',
		'/?page=1',
		'/?page=2',
		'/?page=3'
	]);
});

test('pagination using searchParams', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);

		response.end(JSON.stringify({
			currentUrl: request.url,
			next: page < 3
		}));
	});

	interface Page {
		currentUrl: string;
		next?: string;
	}

	const all = await got.paginate.all('', {
		searchParams: {
			page: 0
		},
		responseType: 'json',
		pagination: {
			transform: (response: Response<Page>) => {
				return [response.body.currentUrl];
			},
			paginate: (response: Response<Page>) => {
				const {next} = response.body;
				const previousPage = Number(response.request.options.searchParams!.get('page'));

				if (!next) {
					return false;
				}

				return {
					searchParams: {
						page: previousPage + 1
					}
				};
			}
		}
	});

	t.deepEqual(all, [
		'/?page=0',
		'/?page=1',
		'/?page=2',
		'/?page=3'
	]);
});

test('pagination using extended searchParams', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		const parameters = new URLSearchParams(request.url.slice(2));
		const page = Number(parameters.get('page') ?? 0);

		response.end(JSON.stringify({
			currentUrl: request.url,
			next: page < 3
		}));
	});

	interface Page {
		currentUrl: string;
		next?: string;
	}

	const client = got.extend({
		searchParams: {
			limit: 10
		}
	});

	const all = await client.paginate.all('', {
		searchParams: {
			page: 0
		},
		responseType: 'json',
		pagination: {
			transform: (response: Response<Page>) => {
				return [response.body.currentUrl];
			},
			paginate: (response: Response<Page>) => {
				const {next} = response.body;
				const previousPage = Number(response.request.options.searchParams!.get('page'));

				if (!next) {
					return false;
				}

				return {
					searchParams: {
						page: previousPage + 1
					}
				};
			}
		}
	});

	t.deepEqual(all, [
		'/?page=0&limit=10',
		'/?page=1&limit=10',
		'/?page=2&limit=10',
		'/?page=3&limit=10'
	]);
});
