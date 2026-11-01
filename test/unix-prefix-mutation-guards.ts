import process from 'node:process';
import assert from 'node:assert/strict';
import got, {type Options} from '../source/index.js';
import test from './helpers/test.js';
import {withSocketServer} from './helpers/with-server.js';

if (process.platform !== 'win32') {
	for (const phase of ['handler', 'beforeRequest', 'beforeRetry', 'afterResponse', 'pagination'] as const) {
		test(`a unix prefix rejects a different socket in ${phase}`, withSocketServer, async (t, firstServer) => {
			await withSocketServer(t, async (_t, secondServer) => {
				let sourceRequests = 0;
				firstServer.removeAllListeners('request');
				firstServer.on('request', (_request, response) => {
					sourceRequests++;
					response.statusCode = phase === 'beforeRetry' ? 503 : 200;
					response.end('[1]');
				});
				let targetRequests = 0;
				secondServer.removeAllListeners('request');
				secondServer.on('request', (_request, response) => {
					targetRequests++;
					response.end('[2]');
				});
				const update = <OptionsType extends Pick<Options, 'url'>>(options: OptionsType): OptionsType => {
					assert.ok(options.url instanceof URL);
					options.url.pathname = `${secondServer.socketPath}:/target`;
					return options;
				};

				const client = got.extend({
					prefixUrl: `unix:${firstServer.socketPath}:/`,
					enableUnixSockets: true,
					allowAbsoluteUrls: false,
					agent: {http: false},
					retry: {limit: phase === 'beforeRetry' ? 1 : 0, backoffLimit: 0, noise: 0},
					handlers: phase === 'handler' ? [(options, next) => next(update(options))] : [],
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
						afterResponse: phase === 'afterResponse' ? [(response, retry) => retry(update(response.request.options))] : [],
					},
				});
				await assert.rejects(async () => phase === 'pagination'
					? client.paginate.all('resource', {pagination: {requestLimit: 2, paginate: ({response}) => update(response.request.options)}})
					: client('resource'), {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'});
				assert.strictEqual(targetRequests, 0);
				assert.strictEqual(sourceRequests, ['beforeRetry', 'afterResponse', 'pagination'].includes(phase) ? 1 : 0);
			});
		});
	}

	test('a unix prefix rejects a live URL edit to a network origin', withSocketServer, async (_t, server) => {
		let requests = 0;
		server.removeAllListeners('request');
		server.on('request', (_request, response) => {
			requests++;
			response.end('unexpected');
		});
		await assert.rejects(got('resource', {
			prefixUrl: `unix:${server.socketPath}:/`,
			enableUnixSockets: true,
			allowAbsoluteUrls: false,
			retry: {limit: 0},
			hooks: {
				beforeRequest: [options => {
					assert.ok(options.url instanceof URL);
					options.url.hostname = 'example.invalid';
				}],
			},
		}), {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'});
		assert.strictEqual(requests, 0);
	});
}
