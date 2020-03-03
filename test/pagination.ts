import test from 'ava';
import got, {Response} from '../source';
import withServer from './helpers/with-server';
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
		const searchParams = new URLSearchParams(request.url.split('?')[1]);
		const page = Number(searchParams.get('page')) || 1;

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

	const result = await got.paginate.all('');

	t.deepEqual(result, [1, 2]);
});

test('retrieves all elements with JSON responseType', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend({
		responseType: 'json'
	}).paginate.all('');

	t.deepEqual(result, [1, 2]);
});

test('points to defaults when extending Got without custom `_pagination`', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend().paginate.all('');

	t.deepEqual(result, [1, 2]);
});

test('pagination options can be extended', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const result = await got.extend({
		_pagination: {
			shouldContinue: () => false
		}
	}).paginate.all('');

	t.deepEqual(result, []);
});

test('filters elements', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all({
		_pagination: {
			filter: element => element !== 2
		}
	});

	t.deepEqual(result, [1, 3]);
});

test('parses elements', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all('?page=100', {
		_pagination: {
			transform: (response: Response) => [(response as Response<string>).body.length]
		}
	});

	t.deepEqual(result, [5]);
});

test('parses elements - async function', withServer, async (t, server, got) => {
	attachHandler(server, 100);

	const result = await got.paginate.all('?page=100', {
		_pagination: {
			transform: async (response: Response) => [(response as Response<string>).body.length]
		}
	});

	t.deepEqual(result, [5]);
});

test('custom paginate function', withServer, async (t, server, got) => {
	attachHandler(server, 3);

	const result = await got.paginate.all({
		_pagination: {
			paginate: response => {
				if (response.request.options.path === '/?page=3') {
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

	const results = [];

	for await (const item of got.paginate('')) {
		results.push(item);
	}

	t.deepEqual(results, [1, 2, 3, 4, 5]);
});

test('`shouldContinue` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		_pagination: {
			shouldContinue: () => false
		}
	};

	const results = [];

	for await (const item of got.paginate(options)) {
		results.push(item);
	}

	t.deepEqual(results, []);
});

test('`countLimit` works', withServer, async (t, server, got) => {
	attachHandler(server, 2);

	const options = {
		_pagination: {
			countLimit: 1
		}
	};

	const results = [];

	for await (const item of got.paginate(options)) {
		results.push(item);
	}

	t.deepEqual(results, [1]);
});

test('throws if no `pagination` option', async t => {
	const iterator = got.extend({
		_pagination: false as any
	}).paginate('', {
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options._pagination` must be implemented'
	});
});

test('throws if the `pagination` option does not have `transform` property', async t => {
	const iterator = got.paginate('', {
		_pagination: {...resetPagination},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options._pagination.transform` must be implemented'
	});
});

test('throws if the `pagination` option does not have `shouldContinue` property', async t => {
	const iterator = got.paginate('', {
		_pagination: {
			...resetPagination,
			transform: thrower
		},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options._pagination.shouldContinue` must be implemented'
	});
});

test('throws if the `pagination` option does not have `filter` property', async t => {
	const iterator = got.paginate('', {
		_pagination: {
			...resetPagination,
			transform: thrower,
			shouldContinue: thrower
		},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options._pagination.filter` must be implemented'
	});
});

test('throws if the `pagination` option does not have `paginate` property', async t => {
	const iterator = got.paginate('', {
		_pagination: {
			...resetPagination,
			transform: thrower,
			shouldContinue: thrower,
			filter: thrower
		},
		prefixUrl: 'https://example.com'
	});

	await t.throwsAsync(iterator.next(), {
		message: '`options._pagination.paginate` must be implemented'
	});
});
