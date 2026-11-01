import assert from 'node:assert/strict';
import getStream from 'get-stream';
import {type Options} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const phase of ['beforeRetry', 'afterResponse', 'pagination'] as const) {
	test(`${phase} preserves payload header state when a live URL edit fails prefix validation`, withServer, async (t, server, got) => {
		let sourceRequests = 0;
		server.post('/', async (request, response) => {
			sourceRequests++;
			assert.strictEqual(await getStream(request), 'one');
			response.status(phase === 'beforeRetry' ? 503 : 200).end('[1]');
		});
		await withServer(t, async (_t, destination) => {
			let destinationRequests = 0;
			destination.post('/', (_request, response) => {
				destinationRequests++;
				response.end('[2]');
			});
			let observedOptions: Options | undefined;
			const update = (options: Options) => {
				observedOptions = options;
				assert.ok(options.url instanceof URL);
				options.url.port = new URL(destination.url).port;
				options.body = 'replacement payload';
				return options;
			};

			const options = {
				allowAbsoluteUrls: false,
				method: 'POST',
				body: 'one',
				headers: {'content-type': 'text/plain'},
				retry: {limit: phase === 'beforeRetry' ? 1 : 0, methods: ['POST'], calculateDelay: () => 1},
			};
			const operation = phase === 'pagination'
				? got.paginate.all('', {...options, pagination: {paginate: ({response}) => update(response.request.options)}})
				: got('', {
					...options,
					hooks: {
						beforeRetry: phase === 'beforeRetry'
							? [error => {
								update(error.options);
							}]
							: [],
						afterResponse: phase === 'afterResponse' ? [(response, retry) => retry(update(response.request.options))] : [],
					},
				});
			await assert.rejects(operation, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'});
			assert.ok(observedOptions);
			assert.strictEqual(observedOptions.body, 'replacement payload');
			// Request retry cleanup owns header changes after validation; response and pagination updates reframe their payload first.
			assert.strictEqual(observedOptions.headers['content-length'], phase === 'beforeRetry' ? '3' : undefined);
			assert.strictEqual(observedOptions.headers['content-type'], 'text/plain');
			assert.strictEqual(sourceRequests, 1);
			assert.strictEqual(destinationRequests, 0);
		});
	});
}
