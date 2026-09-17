import {Readable} from 'node:stream';
import test from 'ava';
import {TimeoutError} from '../source/index.js';
import withServer from './helpers/with-server.js';

test('response timeout starts after a replacement stream upload on redirect', withServer, async (t, server, got) => {
	server.put('/', (request, response) => {
		request.resume();
		request.on('end', () => {
			response.redirect(307, '/next');
		});
	});
	server.put('/next', request => {
		request.resume();
	});

	const error = await t.throwsAsync(got.put('', {
		body: Readable.from(['first']),
		retry: {limit: 0},
		timeout: {response: 100, request: 1500},
		hooks: {
			beforeRedirect: [options => {
				options.body = Readable.from(['second']);
			}],
		},
	}), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

for (const statusCode of [307, 308]) {
	test(`replacement streams report uploaded bytes after a ${statusCode} redirect`, withServer, async (t, server, got) => {
		const bodies: string[] = [];
		server.put('/', async (request, response) => {
			bodies.push((await request.toArray()).join(''));
			response.redirect(statusCode, '/next');
		});
		server.put('/next', async (request, response) => {
			bodies.push((await request.toArray()).join(''));
			response.end('done');
		});

		const response = await got.put('', {
			body: Readable.from(['first']),
			retry: {limit: 0},
			hooks: {
				beforeRedirect: [options => {
					options.body = Readable.from(['longer ', 'replacement']);
				}],
			},
		});

		t.deepEqual(bodies, ['first', 'longer replacement']);
		t.deepEqual(response.request.uploadProgress, {percent: 1, transferred: 18, total: 18});
	});
}
