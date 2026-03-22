import process from 'node:process';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {format} from 'node:util';
import test from 'ava';
import type {Handler} from 'express';
import getStream from 'get-stream';
import baseGot, {Options, RequestError} from '../source/index.js';
import {withSocketServer} from './helpers/with-server.js';
import type {ExtendedHttpServer} from './helpers/types.js';

const got = baseGot.extend({enableUnixSockets: true});

const okHandler: Handler = (_request, response) => {
	response.end('ok');
};

const redirectHandler: Handler = (_request, response) => {
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

	server.on(path, async (request, response) => {
		requestBody = await getStream(request);
		contentType = request.headers['content-type'];
		response.end(responseBody);
	});

	return {
		body: () => requestBody,
		contentType: () => contentType,
	};
}

if (process.platform !== 'win32') {
	test('works', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = socketUrl(server.socketPath);
		t.is((await got(url, {})).body, 'ok');
	});

	test('protocol-less works', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('address with : works', withSocketServer, async (t, server) => {
		server.on('/foo:bar', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/foo:bar');
		t.is((await got(url)).body, 'ok');
	});

	test('throws on invalid URL', async t => {
		try {
			await got('unix:', {retry: {limit: 0}});
		} catch (error: any) {
			t.regex(error.code, /ENOTFOUND|EAI_AGAIN/);
		}
	});

	test('works when extending instances', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		const instance = got.extend({prefixUrl: url});
		t.is((await instance('')).body, 'ok');
	});

	test('passes search params', withSocketServer, async (t, server) => {
		server.on('/?a=1', okHandler);

		const url = socketUrl(server.socketPath, '/?a=1');
		t.is((await got(url)).body, 'ok');
	});

	test('redirects work', withSocketServer, async (t, server) => {
		server.on('/', redirectHandler);
		server.on('/foo', okHandler);

		const url = socketUrl(server.socketPath);
		t.is((await got(url)).body, 'ok');
	});

	test('redirects to a different UNIX socket fail', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
			firstServer.on('/', (_request, response) => {
				response.writeHead(302, {
					location: format('unix:%s:%s', secondServer.socketPath, '/foo'),
				});
				response.end();
			});

			secondServer.on('/foo', okHandler);

			const url = socketUrl(firstServer.socketPath);
			await t.throwsAsync(got(url), {
				message: 'Cannot redirect to UNIX socket',
				instanceOf: RequestError,
			});
		});
	});

	test('`unix:` fails when UNIX sockets are not enabled', async t => {
		const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

		t.false(gotUnixSocketsDisabled.defaults.options.enableUnixSockets);
		await t.throwsAsync(
			gotUnixSocketsDisabled('unix:'),
			{
				message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
			},
		);
	});

	test('`http://unix/path.sock:/` fails when UNIX sockets are not enabled', async t => {
		const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

		t.false(gotUnixSocketsDisabled.defaults.options.enableUnixSockets);

		await t.throwsAsync(
			gotUnixSocketsDisabled('http://unix/tmp/test.sock:/'),
			{
				message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
			},
		);
	});

	test('mutating the URL to a UNIX socket in place still requires opt-in', t => {
		const options = new Options('http://example.com');
		(options.url as URL).href = 'http://unix:/tmp/test.sock:/';

		t.throws(() => {
			options.createNativeRequestOptions();
		}, {
			message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
		});
	});

	test('retryWithMergedOptions strips sensitive headers when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
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

			t.is(result.authorization, undefined);
			t.is(result.cookie, undefined);
		});
	});

	test('pagination strips sensitive headers when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
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

			t.deepEqual(result, [1]);
			t.is(authorization, undefined);
			t.is(cookie, undefined);
		});
	});

	test('retryWithMergedOptions drops body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
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

			t.is(capturedRequest.body(), '');
			t.is(capturedRequest.contentType(), undefined);
		});
	});

	test('pagination drops body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
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

			t.deepEqual(result, [1]);
			t.is(capturedRequest.body(), '');
			t.is(capturedRequest.contentType(), undefined);
		});
	});

	test('retryWithMergedOptions preserves explicit replacement body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
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

			t.is(JSON.parse(capturedRequest.body()).secret, 'new-payload');
			t.is(capturedRequest.contentType(), 'application/json');
		});
	});

	test('pagination preserves explicit replacement body when moving to a different UNIX socket', withSocketServer, async (t, firstServer) => {
		await withSocketServer.exec(t, async (t, secondServer) => {
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

			t.deepEqual(result, [1, 2]);
			t.is(JSON.parse(capturedRequest.body()).secret, 'new-payload');
			t.is(capturedRequest.contentType(), 'application/json');
		});
	});

	test('retryWithMergedOptions preserves body and headers on the same UNIX socket', withSocketServer, async (t, server) => {
		let requestNumber = 0;
		let secondAuthorization: string | undefined;
		server.on('/', async (request, response) => {
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

		t.is(JSON.parse(response.body).secret, 'payload');
		t.is(secondAuthorization, 'Bearer secret');
	});

	test('pagination preserves body on the same UNIX socket', withSocketServer, async (t, server) => {
		const payloads: string[] = [];
		const handler = async (request: IncomingMessage, response: ServerResponse) => {
			payloads.push(await getStream(request));
			response.end(JSON.stringify([payloads.length]));
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

		t.deepEqual(result, [1, 2]);
		t.deepEqual(payloads.map(payload => JSON.parse(payload).secret), ['payload', 'payload']);
	});
}
