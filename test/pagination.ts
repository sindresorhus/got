import {Agent as HttpsAgent} from 'https';
import {URL} from 'url';
import test from 'ava';
import got, {ExtendOptions, Response} from '../source';
import withServer, {withBodyParsingServer} from './helpers/with-server';
import {ExtendedTestServer} from './helpers/types';

const thrower = (): any => {
	throw new Error('This should not be called');
};

const resetPagination = {
	paginate: undefined,
	transform: undefined,
	filter: undefined,
	shouldContinue: undefined
};

const attachHandler = (server: ExtendedTestServer, count: number): void => {
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

	const result = await got.paginate.all<number>('?page=100', {
		pagination: {
			transform: (response: Response) => [(response as Response<string>).body.length]
		}
	});

	t.deepEqual(result, [5]);
});

test('parses elements - async function', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all<number>('?page=100', {
		pagination: {
			transform: async (response: Response) => [(response as Response<string>).body.length]
		}
	});

	t.deepEqual(result, [5]);
});

test('custom paginate function', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all<number>({
		pagination: {
			paginate: (response: Response) => {
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
			paginate: (_response: Response, allItems: number[]) => {
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
			paginate: (_response: Response, _allItems: number[], currentItems: number[]) => {
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

test.failing('allowGetBody sends json payload with .paginate()', withBodyParsingServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.body.hello !== 'world') {
			response.statusCode = 400;
		}

		response.end(JSON.stringify([1, 2, 3]));
	});

	const iterator = got.paginate({
		allowGetBody: true,
		json: {hello: 'world'},
		retry: 0
	});

	const result = await iterator.next();

	t.deepEqual(result.value, [1, 2, 3]);
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

test('keepAlive and .paginate()', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end(JSON.stringify([1, 2, 3]));
	});

	server.post('/', (_request, response) => {
		response.end(JSON.stringify({access_token: 'unicorn'}));
	});

	const baseOptions: ExtendOptions = {agent: {https: new HttpsAgent({keepAlive: true})}};
	const authOptions: ExtendOptions = {
		method: 'POST',
		json: {}
	};

	const authenticationInstance = got.extend(baseOptions, authOptions);

	const getNewAuthToken = async (): Promise<string> => {
		const responsePromise = authenticationInstance('');
		const body: {access_token: string} = await responsePromise.json();
		return body.access_token;
	};

	const authenticatedInstance = got.extend(baseOptions, {
		allowGetBody: true,
		hooks: {
			afterResponse: [
				async (response, retryWithMergedOptions) => {
					// Unauthorized
					if (response.statusCode === 401) {
						const updatedOptions: ExtendOptions = {headers: {token: await getNewAuthToken()}};

						// Save for further requests
						authenticatedInstance.defaults.options = got.mergeOptions(
							authenticatedInstance.defaults.options,
							updatedOptions
						);

						return retryWithMergedOptions(updatedOptions);
					}

					// No changes otherwise
					return response;
				}
			]
		},
		mutableDefaults: true
	});

	const iterator = authenticatedInstance.paginate({
		// TODO: cleanup
		rejectUnauthorized: false,
		allowGetBody: true,
		json: {hello: 'world'},
		retry: 0
	});

	let i = 0;
	for await (const value of iterator) {
		t.is(value, i += 1);
	}
});
