import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import delay from 'delay';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const direct of [false, true]) {
	test(`raw EOF ends the read budget before a pending cookie store finishes with direct response ${direct}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('set-cookie', 'session=one');
			response.end('complete');
		});
		const storing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let failures = 0;
		const result = got('', {
			retry: {limit: 0},
			timeout: {read: 20, request: 1000},
			request: direct
				? async (url, options) => {
					const request = http.get(url, options);
					const [response] = await once(request, 'response');
					return response as http.IncomingMessage;
				}
				: undefined,
			cookieJar: {
				async getCookieString() {
					return '';
				},
				async setCookie() {
					storing.resolve();
					await release.promise;
				},
			},
			hooks: {
				beforeError: [error => {
					failures++;
					return error;
				}],
			},
		});

		try {
			await storing.promise;
			// The raw response is captured while the asynchronous store holds finalization.
			await Promise.race([delay(50), result.then(() => assert.fail('The response must wait for its cookie store'))]);
			assert.strictEqual(failures, 0);
		} finally {
			release.resolve();
		}

		assert.strictEqual((await result).body, 'complete');
		assert.strictEqual(failures, 0);
	});
}

test('a direct-response redirect cancels its read budget before an asynchronous redirect hook', withServer, async (_t, server, got) => {
	const visited: string[] = [];
	server.get('/first', (request, response) => {
		visited.push(request.path);
		response.writeHead(302, {location: '/second'}).end();
	});
	server.get('/second', (request, response) => {
		visited.push(request.path);
		response.end('complete');
	});
	const response = await got('first', {
		retry: {limit: 0},
		timeout: {read: 20, request: 1000},
		async request(url, options) {
			const request = http.get(url, options);
			const [response] = await once(request, 'response');
			return response as http.IncomingMessage;
		},
		hooks: {
			beforeRedirect: [async () => {
				await delay(50);
			}],
		},
	});
	assert.strictEqual(response.body, 'complete');
	assert.deepStrictEqual(visited, ['/first', '/second']);
});
