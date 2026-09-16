import test from 'ava';
import withServer from './helpers/with-server.js';

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
