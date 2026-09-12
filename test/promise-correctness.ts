import test from 'ava';
import getStream from 'get-stream';
import withServer from './helpers/with-server.js';

test('manual retry with new JSON preserves an explicit content type', withServer, async (t, server, got) => {
	const contentTypes: Array<string | undefined> = [];
	const bodies: string[] = [];
	server.post('/', async (request, response) => {
		contentTypes.push(request.headers['content-type']);
		bodies.push(await getStream(request));
		response.end('done');
	});

	await got.post('', {
		json: {attempt: 1},
		headers: {'content-type': 'application/vnd.api+json'},
		hooks: {
			afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({json: {attempt: 2}})],
		},
	});

	t.deepEqual(bodies, ['{"attempt":1}', '{"attempt":2}']);
	t.deepEqual(contentTypes, ['application/vnd.api+json', 'application/vnd.api+json']);
});
