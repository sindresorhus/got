import test from 'ava';
import getStream from 'get-stream';
import withServer from './helpers/with-server.js';

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

