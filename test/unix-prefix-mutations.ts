import process from 'node:process';
import assert from 'node:assert/strict';
import got, {type Options} from '../source/index.js';
import test from './helpers/test.js';
import {withSocketServer} from './helpers/with-server.js';

if (process.platform !== 'win32') {
	for (const phase of ['handler', 'beforeRequest', 'beforeRetry', 'afterResponse', 'pagination'] as const) {
		test(`a unix prefix permits same-socket URL edits in ${phase}`, withSocketServer, async (_t, server) => {
			const requests: string[] = [];
			server.removeAllListeners('request');
			server.on('request', (request, response) => {
				requests.push(request.url!);
				response.statusCode = phase === 'beforeRetry' && requests.length === 1 ? 503 : 200;
				response.end(JSON.stringify([request.url]));
			});
			const update = <OptionsType extends Pick<Options, 'url' | 'searchParams'>>(options: OptionsType): OptionsType => {
				assert.ok(options.url instanceof URL);
				options.url.pathname = `${server.socketPath}:/target`;
				options.searchParams.set('page', '2');
				return options;
			};

			const client = got.extend({
				prefixUrl: `unix:${server.socketPath}:/`,
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
			if (phase === 'pagination') {
				assert.deepStrictEqual(await client.paginate.all<string>('resource', {
					pagination: {requestLimit: 2, paginate: ({response}) => update(response.request.options)},
				}), ['/resource', '/target?page=2']);
			} else {
				assert.deepStrictEqual(await client('resource').json<string[]>(), ['/target?page=2']);
			}

			assert.deepStrictEqual(requests, ['beforeRetry', 'afterResponse', 'pagination'].includes(phase) ? ['/resource', '/target?page=2'] : ['/target?page=2']);
		});
	}
}
