import assert from 'node:assert/strict';
import getStream from 'get-stream';
import {type Options} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import {createCrossOriginReceiver} from './helpers/server-tools.js';

for (const phase of ['beforeRequest', 'beforeRetry', 'beforeRedirect', 'afterResponse', 'pagination'] as const) {
	for (const header of ['username', 'password', 'url', 'body', 'json', 'form']) {
		test(`the ${header} header cannot retain private request state across origins in ${phase}`, withServer, async (t, server, got) => {
			let sourceRequests = 0;
			server.all('/', (request, response) => {
				sourceRequests++;
				request.resume();
				if (phase === 'beforeRedirect') {
					response.writeHead(302, {location: '/next'}).end();
					return;
				}

				response.statusCode = phase === 'beforeRetry' ? 503 : 200;
				response.end('[1]');
			});
			const {server: receiver, received} = await createCrossOriginReceiver('/steal', '[2]');
			t.after(receiver.close);
			receiver.put('/steal', async (request, response) => {
				received.authorization = request.headers.authorization;
				received.body = await getStream(request);
				response.end('[2]');
			});
			const update = <OptionsType extends Pick<Options, 'url' | 'headers'>>(options: OptionsType): OptionsType => {
				assert.ok(options.url instanceof URL);
				options.url.host = new URL(receiver.url).host;
				options.url.pathname = '/steal';
				options.headers[header] = 'public header';
				return options;
			};

			const client = got.extend({
				method: phase === 'beforeRedirect' ? 'PUT' : 'POST',
				username: 'client',
				password: 'secret',
				retry: {
					limit: phase === 'beforeRetry' ? 1 : 0, methods: ['POST'], backoffLimit: 0, noise: 0,
				},
				hooks: {
					beforeRequest: phase === 'beforeRequest'
						? [options => {
							update(options);
						}]
						: [],
					beforeRetry: phase === 'beforeRetry'
						? [error => {
							update(error.options);
						}]
						: [],
					beforeRedirect: phase === 'beforeRedirect'
						? [options => {
							update(options);
						}]
						: [],
					afterResponse: phase === 'afterResponse' ? [(response, retry) => retry(update(response.request.options))] : [],
				},
			});

			if (phase === 'pagination') {
				assert.deepStrictEqual(await client.paginate.all<number>('', {
					body: 'private upload',
					pagination: {requestLimit: 2, paginate: ({response}) => update(response.request.options)},
				}), [1, 2]);
			} else {
				assert.strictEqual(await client('', {body: 'private upload'}).text(), '[2]');
			}

			assert.strictEqual(received.authorization, undefined);
			assert.strictEqual(received.body, '');
			assert.strictEqual(sourceRequests, phase === 'beforeRequest' ? 0 : 1);
		});
	}
}
