import process from 'node:process';
import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import {join} from 'node:path';
import {format, promisify} from 'node:util';
import assert from 'node:assert/strict';
import getStream from 'get-stream';
import {temporaryDirectory} from 'tempy';
import baseGot, {Options, RequestError} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import {withSocketServer} from './helpers/with-server.js';
import type {ExtendedHttpServer} from './helpers/types.js';

const got = baseGot.extend({enableUnixSockets: true});

const okHandler = (_request: IncomingMessage, response: ServerResponse): void => {
	response.end('ok');
};

const redirectHandler = (_request: IncomingMessage, response: ServerResponse): void => {
	response.writeHead(302, {
		location: 'foo',
	});
	response.end();
};

function socketUrl(socketPath: string, path = '/'): string {
	return format('http://unix:%s:%s', socketPath, path);
}

function attachRetryUrlResponse(server: ExtendedHttpServer, socketPath: string, path = '/target'): void {
	server.on('/', (_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({
			retryUrl: socketUrl(socketPath, path),
		}));
	});
}

function readRetryUrl(responseBody: string): URL {
	return new URL(JSON.parse(responseBody).retryUrl);
}

function withDisabledHttpAgent(): {agent: {http: false}} {
	return {
		agent: {
			http: false,
		},
	};
}

function captureRequest(server: ExtendedHttpServer, path: string, responseBody: string): {body: () => string; contentType: () => string | undefined} {
	let requestBody = '';
	let contentType: string | undefined;

	server.on(path, (request, response) => {
		void (async () => {
			requestBody = await getStream(request);
			contentType = request.headers['content-type'];
			response.end(responseBody);
		})();
	});

	return {
		body: () => requestBody,
		contentType: () => contentType,
	};
}

if (process.platform !== 'win32') {
	test('works', withSocketServer, async (_t, server) => {
		void server.on('/', okHandler);

		const url = socketUrl(server.socketPath);
		assert.strictEqual((await got(url, {})).body, 'ok');
	});

	test('protocol-less works', withSocketServer, async (_t, server) => {
		void server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		assert.strictEqual((await got(url)).body, 'ok');
	});

	test('works with a socket path that needs percent-encoding', async t => {
		const socketPath = join(temporaryDirectory(), 'a b.sock');
		const server = http.createServer(okHandler);
		// @ts-expect-error TypeScript doesn't accept `callback` with no arguments
		await promisify<any>(server.listen.bind(server))(socketPath);
		t.after(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close(error => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				});
			});
		});

		assert.strictEqual((await got(socketUrl(socketPath))).body, 'ok');
		assert.strictEqual((await got(format('unix:%s:%s', socketPath, '/'))).body, 'ok');
	});

	test('address with : works', withSocketServer, async (_t, server) => {
		void server.on('/foo:bar', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/foo:bar');
		assert.strictEqual((await got(url)).body, 'ok');
	});

	test('throws on invalid URL', async _t => {
		const error = await rejects(got('unix:', {retry: {limit: 0}}));
		assert.match(error?.code ?? '', /ENOTFOUND|EAI_AGAIN/v);
	});

	test('works when extending instances', withSocketServer, async (_t, server) => {
		void server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		const instance = got.extend({prefixUrl: url});
		assert.strictEqual((await instance('')).body, 'ok');
	});

	test('passes search params', withSocketServer, async (_t, server) => {
		void server.on('/?a=1', okHandler);

		const url = socketUrl(server.socketPath, '/?a=1');
		assert.strictEqual((await got(url)).body, 'ok');
	});

	test('redirects work', withSocketServer, async (_t, server) => {
		void server.on('/', redirectHandler);
		void server.on('/foo', okHandler);

		const url = socketUrl(server.socketPath);
		assert.strictEqual((await got(url)).body, 'ok');
	});

	test('redirects to a different UNIX socket fail', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			firstServer.on('/', (_request, response) => {
				response.writeHead(302, {
					location: format('unix:%s:%s', secondServer.socketPath, '/foo'),
				});
				response.end();
			});

			void secondServer.on('/foo', okHandler);

			const url = socketUrl(firstServer.socketPath);
			await assert.rejects(got(url), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
		});
	});

	test('`unix:` fails when UNIX sockets are not enabled', async _t => {
		const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

		assert.strictEqual(gotUnixSocketsDisabled.defaults.options.enableUnixSockets, false);
		await assert.rejects(
			gotUnixSocketsDisabled('unix:'),
			{
				message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
			},
		);
	});

	test('`http://unix/path.sock:/` fails when UNIX sockets are not enabled', async _t => {
		const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

		assert.strictEqual(gotUnixSocketsDisabled.defaults.options.enableUnixSockets, false);

		await assert.rejects(
			gotUnixSocketsDisabled('http://unix/tmp/test.sock:/'),
			{
				message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
			},
		);
	});

	test('mutating the URL to a UNIX socket in place still requires opt-in', _t => {
		const options = new Options('http://example.com');
		(options.url as URL).href = 'http://unix:/tmp/test.sock:/';

		assert.throws(() => {
			options.createNativeRequestOptions();
		}, {
			message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
		});
	});

	test('allowAbsoluteUrls false rejects in-place mutation to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			void firstServer.on('/', okHandler);

			const client = got.extend({
				allowAbsoluteUrls: false,
				prefixUrl: socketUrl(firstServer.socketPath),
			});

			await assert.rejects(client('', {
				hooks: {
					beforeRequest: [
						options => {
							options.url!.pathname = `${secondServer.socketPath}:/`;
						},
					],
				},
			}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
		});
	});

	test('allowAbsoluteUrls false rejects retryWithMergedOptions string URL to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			firstServer.on('/', (_request, response) => {
				response.end('first');
			});

			void secondServer.on('/target', okHandler);

			const client = got.extend({
				allowAbsoluteUrls: false,
				prefixUrl: socketUrl(firstServer.socketPath),
			});

			await assert.rejects(client('', {
				hooks: {
					afterResponse: [
						(_response, retryWithMergedOptions) => retryWithMergedOptions({
							url: format('unix:%s:%s', secondServer.socketPath, '/target'),
						}),
					],
				},
			}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
		});
	});

	test('allowAbsoluteUrls false rejects retryWithMergedOptions backslash URL to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			firstServer.on('/', (_request, response) => {
				response.end('first');
			});

			void secondServer.on('/target', okHandler);

			const client = got.extend({
				allowAbsoluteUrls: false,
				prefixUrl: socketUrl(firstServer.socketPath),
			});

			await assert.rejects(client('', {
				hooks: {
					afterResponse: [
						(_response, retryWithMergedOptions) => retryWithMergedOptions({
							url: format(String.raw`\\unix:%s:%s`, secondServer.socketPath, '/target'),
						}),
					],
				},
			}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
		});
	});

	test('retryWithMergedOptions strips sensitive headers when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			attachRetryUrlResponse(firstServer, secondServer.socketPath);

			secondServer.on('/target', (request, response) => {
				response.end(JSON.stringify({
					authorization: request.headers.authorization,
					cookie: request.headers.cookie,
				}));
			});

			const url = socketUrl(firstServer.socketPath);
			const result = await got(url, {
				headers: {
					authorization: 'Bearer secret',
					cookie: 'session=abc',
				},
				hooks: {
					afterResponse: [
						(response, retryWithMergedOptions) => retryWithMergedOptions({
							url: readRetryUrl(response.body as string),
						}),
					],
				},
			}).json<{authorization: string | undefined; cookie: string | undefined}>();

			assert.strictEqual(result.authorization, undefined);
			assert.strictEqual(result.cookie, undefined);
		});
	});

	test('pagination strips sensitive headers when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			let authorization: string | undefined;
			let cookie: string | undefined;
			firstServer.on('/', (_request, response) => {
				response.end('[1]');
			});

			secondServer.on('/target', (request, response) => {
				authorization = request.headers.authorization;
				cookie = request.headers.cookie;
				response.end('[]');
			});

			const url = socketUrl(firstServer.socketPath);
			const result = await got.paginate.all<number>(url, {
				headers: {
					authorization: 'Bearer secret',
					cookie: 'session=abc',
				},
				pagination: {
					requestLimit: 2,
					paginate({response}) {
						if (response.body === '[1]') {
							return {
								url: new URL(socketUrl(secondServer.socketPath, '/target')),
							};
						}

						return false;
					},
				},
			});

			assert.deepStrictEqual(result, [1]);
			assert.strictEqual(authorization, undefined);
			assert.strictEqual(cookie, undefined);
		});
	});

	test('retryWithMergedOptions drops body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			attachRetryUrlResponse(firstServer, secondServer.socketPath);
			const capturedRequest = captureRequest(secondServer, '/target', 'ok');
			const url = socketUrl(firstServer.socketPath);
			await got.post(url, {
				...withDisabledHttpAgent(),
				json: {secret: 'payload'},
				hooks: {
					afterResponse: [
						(response, retryWithMergedOptions) => retryWithMergedOptions({
							url: readRetryUrl(response.body as string),
						}),
					],
				},
			});

			assert.strictEqual(capturedRequest.body(), '');
			assert.strictEqual(capturedRequest.contentType(), undefined);
		});
	});

	test('pagination drops body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			firstServer.on('/', (_request, response) => {
				response.end('[1]');
			});

			const capturedRequest = captureRequest(secondServer, '/target', '[]');
			const url = socketUrl(firstServer.socketPath);
			const result = await got.paginate.all<number>(url, {
				...withDisabledHttpAgent(),
				method: 'POST',
				json: {secret: 'payload'},
				pagination: {
					requestLimit: 2,
					paginate({response}) {
						if (response.body === '[1]') {
							return {
								url: new URL(socketUrl(secondServer.socketPath, '/target')),
							};
						}

						return false;
					},
				},
			});

			assert.deepStrictEqual(result, [1]);
			assert.strictEqual(capturedRequest.body(), '');
			assert.strictEqual(capturedRequest.contentType(), undefined);
		});
	});

	test('retryWithMergedOptions preserves explicit replacement body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			attachRetryUrlResponse(firstServer, secondServer.socketPath);
			const capturedRequest = captureRequest(secondServer, '/target', 'ok');
			const url = socketUrl(firstServer.socketPath);
			await got.post(url, {
				...withDisabledHttpAgent(),
				json: {secret: 'old-payload'},
				hooks: {
					afterResponse: [
						(response, retryWithMergedOptions) => retryWithMergedOptions({
							url: readRetryUrl(response.body as string),
							json: {secret: 'new-payload'},
						}),
					],
				},
			});

			assert.strictEqual(JSON.parse(capturedRequest.body()).secret, 'new-payload');
			assert.strictEqual(capturedRequest.contentType(), 'application/json');
		});
	});

	test('pagination preserves explicit replacement body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer(t, async (_t, secondServer) => {
			firstServer.on('/', (_request, response) => {
				response.end('[1]');
			});

			const capturedRequest = captureRequest(secondServer, '/target', '[2]');
			const url = socketUrl(firstServer.socketPath);
			const result = await got.paginate.all<number>(url, {
				...withDisabledHttpAgent(),
				method: 'POST',
				json: {secret: 'old-payload'},
				pagination: {
					requestLimit: 2,
					paginate({response}) {
						if (response.body === '[1]') {
							return {
								url: new URL(socketUrl(secondServer.socketPath, '/target')),
								json: {secret: 'new-payload'},
							};
						}

						return false;
					},
				},
			});

			assert.deepStrictEqual(result, [1, 2]);
			assert.strictEqual(JSON.parse(capturedRequest.body()).secret, 'new-payload');
			assert.strictEqual(capturedRequest.contentType(), 'application/json');
		});
	});

	test('retryWithMergedOptions preserves body and headers on the same UNIX socket', withSocketServer, async (_t, server) => {
		let requestNumber = 0;
		let secondAuthorization: string | undefined;
		server.on('/', (request, response) => {
			void (async () => {
				requestNumber++;
				const body = await getStream(request);

				if (requestNumber === 1) {
					response.setHeader('content-type', 'application/json');
					response.end(JSON.stringify({
						retryUrl: format('http://unix:%s:%s', server.socketPath, '/'),
					}));
					return;
				}

				secondAuthorization = request.headers.authorization;
				response.end(body);
			})();
		});

		const url = socketUrl(server.socketPath);
		const response = await got.post(url, {
			...withDisabledHttpAgent(),
			headers: {
				authorization: 'Bearer secret',
			},
			json: {secret: 'payload'},
			hooks: {
				afterResponse: [
					(response, retryWithMergedOptions) => retryWithMergedOptions({
						url: readRetryUrl(response.body as string),
					}),
				],
			},
		});

		assert.strictEqual(JSON.parse(response.body).secret, 'payload');
		assert.strictEqual(secondAuthorization, 'Bearer secret');
	});

	test('pagination preserves body on the same UNIX socket', withSocketServer, async (_t, server) => {
		const payloads: string[] = [];
		const handler = (request: IncomingMessage, response: ServerResponse): void => {
			void (async () => {
				payloads.push(await getStream(request));
				response.end(JSON.stringify([payloads.length]));
			})();
		};

		server.on('/', handler);
		server.on('/?page=2', handler);

		const url = socketUrl(server.socketPath);
		const result = await got.paginate.all<number>(url, {
			...withDisabledHttpAgent(),
			method: 'POST',
			json: {secret: 'payload'},
			pagination: {
				requestLimit: 2,
				paginate({response}) {
					if (response.body === '[1]') {
						return {
							url: new URL(socketUrl(server.socketPath, '/?page=2')),
						};
					}

					return false;
				},
			},
		});

		assert.deepStrictEqual(result, [1, 2]);
		assert.deepStrictEqual(payloads.map(payload => JSON.parse(payload).secret), ['payload', 'payload']);
	});
}
