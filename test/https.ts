import http2, {type ServerHttp2Stream} from 'node:http2';
import https from 'node:https';
import net, {type LookupFunction} from 'node:net';
import process from 'node:process';
import tls, {type DetailedPeerCertificate} from 'node:tls';
import test from 'ava';
import {pEvent} from 'p-event';
import pify from 'pify';
import pem from 'pem';
import got, {type NativeRequestOptions, type NormalizedOptions} from '../source/index.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import {withHttpsServer} from './helpers/with-server.js';
import type {CreatePrivateKey, CreateCsr, CreateCertificate} from './types/pem.js';

const createPrivateKey = pify(pem.createPrivateKey as CreatePrivateKey);
const createCsr = pify(pem.createCSR as CreateCsr);
const createCertificate = pify(pem.createCertificate as CreateCertificate);

test('https request without ca', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.truthy((await got({
		https: {
			certificateAuthority: [],
			rejectUnauthorized: false,
		},
	})).body);
});

test('https request with ca', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({});

	t.is(body, 'ok');
});

test('https request with ca and afterResponse hook', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const warningListener = (warning: any) => {
		if (
			warning.name === 'DeprecationWarning'
			&& warning.message === 'Got: "options.ca" was never documented, please use '
			+ '"options.https.certificateAuthority"'
		) {
			process.off('warning', warningListener);
			t.fail('unexpected deprecation warning');
		} else {
			t.pass();
		}
	};

	process.once('warning', warningListener);

	let shouldRetry = true;
	const {body} = await got({
		hooks: {
			afterResponse: [
				(response, retry) => {
					if (shouldRetry) {
						shouldRetry = false;

						return retry({});
					}

					return response;
				},
			],
		},
	});

	t.is(body, 'ok');
});

test('https request with `checkServerIdentity` OK', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({
		https: {
			checkServerIdentity(hostname: string, certificate: DetailedPeerCertificate) {
				t.is(hostname, 'localhost');
				t.is(certificate.subject.CN, 'localhost');
				t.is(certificate.issuer.CN, 'authority');
			},
		},
	});

	t.is(body, 'ok');
});

test('https request with `checkServerIdentity` NOT OK', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const promise = got({
		https: {
			checkServerIdentity(hostname: string, certificate: DetailedPeerCertificate) {
				t.is(hostname, 'localhost');
				t.is(certificate.subject.CN, 'localhost');
				t.is(certificate.issuer.CN, 'authority');

				return new Error('CUSTOM_ERROR');
			},
		},
	});

	await t.throwsAsync(
		promise,
		{
			message: 'CUSTOM_ERROR',
		},
	);
});

test('https request with `serverName` option', withHttpsServer(), async (t, server, got) => {
	server.get('/', (request, response) => {
		// Get the servername from the TLS connection
		const {servername} = request.socket as any;
		response.json({servername});
	});

	const {servername} = await got({
		https: {
			serverName: 'custom.example.com',
			rejectUnauthorized: false,
		},
	}).json<{servername: string}>();

	t.is(servername, 'custom.example.com');
});

// The built-in `openssl` on macOS does not support negative days.
{
	const testFunction = process.platform === 'darwin' ? test.skip : test;
	testFunction('https request with expired certificate', withHttpsServer({days: -1}), async (t, _server, got) => {
		await t.throwsAsync(
			got({}),
			{
				code: 'CERT_HAS_EXPIRED',
			},
		);
	});
}

test('https request with wrong host', withHttpsServer({commonName: 'not-localhost.com'}), async (t, _server, got) => {
	await t.throwsAsync(
		got({}),
		{
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
		},
	);
});

test('http2 uses HTTP/2 when ALPN selects h2', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
			'x-protocol': stream.session!.alpnProtocol,
		});
		stream.end('ok');
	});

	try {
		const response = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(response.body, 'ok');
		t.is(response.headers['x-protocol'], 'h2');
		t.false(Object.hasOwn(response.headers, ':status'));
		t.false(response.rawHeaders.includes(':status'));
	} finally {
		await server.close();
	}
});

test('http2 sends RFC 9113 request pseudo-headers', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
			'content-type': 'application/json',
		});
		stream.end(JSON.stringify({
			authority: headers[':authority'],
			method: headers[':method'],
			path: headers[':path'],
			scheme: headers[':scheme'],
			host: headers.host,
		}));
	});

	try {
		const body = await got(`${server.url}/path?query=value`, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		}).json<Record<string, string>>();

		const {port} = new URL(server.url);
		t.like(body, {
			authority: `localhost:${port}`,
			method: 'GET',
			path: '/path?query=value',
			scheme: 'https',
		});
		t.false(Object.hasOwn(body, 'host'));

		const bodyWithCustomHost = await got(`${server.url}/path`, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				host: 'custom.example',
			},
		}).json<Record<string, string>>();

		t.like(bodyWithCustomHost, {
			authority: 'custom.example',
			path: '/path',
		});
		t.false(Object.hasOwn(bodyWithCustomHost, 'host'));
	} finally {
		await server.close();
	}
});

test('http2 strips HTTP/1.x connection-specific request headers', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
			'content-type': 'application/json',
		});
		stream.end(JSON.stringify(headers));
	});

	try {
		const headers = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				connection: 'keep-alive, x-connection-test',
				'http2-settings': 'anything',
				'keep-alive': 'timeout=5',
				'proxy-connection': 'keep-alive',
				'transfer-encoding': 'chunked',
				upgrade: 'websocket',
				te: 'trailers',
				'x-connection-test': 'dropped',
			},
		}).json<Record<string, string>>();

		t.false(Object.hasOwn(headers, 'connection'));
		t.false(Object.hasOwn(headers, 'http2-settings'));
		t.false(Object.hasOwn(headers, 'keep-alive'));
		t.false(Object.hasOwn(headers, 'proxy-connection'));
		t.false(Object.hasOwn(headers, 'transfer-encoding'));
		t.false(Object.hasOwn(headers, 'upgrade'));
		t.false(Object.hasOwn(headers, 'x-connection-test'));
		t.is(headers.te, 'trailers');

		const headersWithInvalidTe = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				te: 'gzip',
			},
		}).json<Record<string, string>>();

		t.false(Object.hasOwn(headersWithInvalidTe, 'te'));

		const headersWithConnectionListedHost = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				host: 'custom.example',
				connection: 'host',
			},
		}).json<Record<string, string>>();

		const {port} = new URL(server.url);
		t.is(headersWithConnectionListedHost[':authority'], `localhost:${port}`);
		t.false(Object.hasOwn(headersWithConnectionListedHost, 'host'));
	} finally {
		await server.close();
	}
});

test('http2 falls back to HTTP/1.1 when ALPN does not select h2', withHttpsServer(), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.httpVersion);
	});

	const {body} = await got({
		http2: true,
	});

	t.is(body, '1.1');
});

test('http2 responses are cached', async t => {
	let streamCount = 0;
	const server = await createHttp2TestServer(stream => {
		streamCount++;
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
			'cache-control': 'public, max-age=60',
		});
		stream.end(String(streamCount));
	});

	try {
		const cache = new Map();
		const instance = got.extend({
			cache,
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		const firstResponse = await instance(server.url);
		const secondResponse = await instance(server.url);

		t.is(firstResponse.body, '1');
		t.is(secondResponse.body, '1');
		t.false(firstResponse.isFromCache);
		t.true(secondResponse.isFromCache);
		t.is(streamCount, 1);
	} finally {
		await server.close();
	}
});

test('http2 supports GET body when allowGetBody is true', async t => {
	const server = await createHttp2TestServer(stream => {
		let body = '';
		stream.setEncoding('utf8');
		stream.on('data', chunk => {
			body += String(chunk);
		});
		stream.on('end', () => {
			stream.respond({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':status': 200,
			});
			stream.end(body);
		});
	});

	try {
		const {body} = await got.get(server.url, {
			http2: true,
			body: 'hello',
			allowGetBody: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, 'hello');
	} finally {
		await server.close();
	}
});

test('http2 retires sessions after GOAWAY', async t => {
	let streamCount = 0;
	let firstSession: NonNullable<ServerHttp2Stream['session']> | undefined;
	let secondSession: NonNullable<ServerHttp2Stream['session']> | undefined;
	let firstSessionClose: Promise<unknown> | undefined;
	const server = await createHttp2TestServer(stream => {
		streamCount++;
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end(String(streamCount));

		if (streamCount === 1) {
			firstSession = stream.session!;
			firstSessionClose = pEvent(firstSession, 'close');
			queueMicrotask(() => {
				stream.session!.goaway();
				stream.session!.close();
			});
		} else {
			secondSession = stream.session!;
		}
	});

	try {
		const options = {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		};

		t.is((await got(server.url, options)).body, '1');
		await firstSessionClose;
		t.is((await got(server.url, options)).body, '2');
		t.not(firstSession, secondSession);
	} finally {
		await server.close();
	}
});

test('http2 sends request trailers', async t => {
	let receivedTrailers: http2.IncomingHttpHeaders | undefined;
	let startBody!: () => void;
	const startBodyPromise = new Promise<void>(resolve => {
		startBody = resolve;
	});
	const server = await createHttp2TestServer(stream => {
		stream.on('trailers', trailers => {
			receivedTrailers = trailers;
		});
		stream.on('end', () => {
			stream.respond({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':status': 200,
			});
			stream.end('ok');
		});
		stream.resume();
	});

	async function * body() {
		await startBodyPromise;
		yield 'hello';
	}

	try {
		await got.post(server.url, {
			http2: true,
			body: body(),
			https: {
				rejectUnauthorized: false,
			},
		}).on('request', request => {
			request.addTrailers({
				'x-checksum': 'abc',
			});
			startBody();
		});

		t.is(receivedTrailers?.['x-checksum'], 'abc');
	} finally {
		await server.close();
	}
});

test('http2 exposes response trailers', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
			trailer: 'x-checksum',
		}, {
			waitForTrailers: true,
		});
		stream.on('wantTrailers', () => {
			stream.sendTrailers({
				'x-checksum': 'abc',
			});
		});
		stream.end('ok');
	});

	try {
		const response = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(response.body, 'ok');
		t.is(response.trailers['x-checksum'], 'abc');
		t.deepEqual(response.rawTrailers, ['x-checksum', 'abc']);
	} finally {
		await server.close();
	}
});

test('http2 supports abort signals', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.resume();
	});
	const controller = new AbortController();

	try {
		const promise = got(server.url, {
			http2: true,
			signal: controller.signal,
			https: {
				rejectUnauthorized: false,
			},
		});

		controller.abort();

		await t.throwsAsync(promise, {
			code: 'ERR_ABORTED',
		});
	} finally {
		await server.close();
	}
});

test('http2 abort closes in-flight ALPN probe', async t => {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const controller = new AbortController();
		const alpnProtocols = 'ALPNProtocols';
		let clientSocket: tls.TLSSocket | undefined;
		const socketPromise = pEvent(server, 'connection') as Promise<net.Socket>;
		const promise = got(`https://127.0.0.1:${port}`, {
			http2: true,
			signal: controller.signal,
			createConnection() {
				clientSocket = tls.connect(port, '127.0.0.1', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername: 'localhost',
				});

				return clientSocket;
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		});
		const rejectionPromise = (async (): Promise<NodeJS.ErrnoException> => {
			try {
				await promise;
				t.fail('Expected request to abort');
			} catch (error: unknown) {
				return error as NodeJS.ErrnoException;
			}

			throw new Error('Expected request to abort');
		})();
		await socketPromise;
		const closePromise = pEvent(clientSocket!, 'close');

		controller.abort();

		const error = await rejectionPromise;
		t.is(error.code, 'ERR_ABORTED');
		await closePromise;
		t.true(clientSocket!.destroyed);
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 request destroy closes in-flight ALPN probe', async t => {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const alpnProtocols = 'ALPNProtocols';
		let clientSocket: tls.TLSSocket | undefined;
		const socketPromise = pEvent(server, 'connection') as Promise<net.Socket>;
		const request = got.stream(`https://127.0.0.1:${port}`, {
			http2: true,
			createConnection() {
				clientSocket = tls.connect(port, '127.0.0.1', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername: 'localhost',
				});

				return clientSocket;
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		});
		const requestClosePromise = pEvent(request, 'close');

		request.resume();
		await socketPromise;
		const closePromise = pEvent(clientSocket!, 'close');

		request.destroy();

		await requestClosePromise;
		await closePromise;
		t.true(clientSocket!.destroyed);
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 request destroy cancels in-flight session setup', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const sockets = new Set<tls.TLSSocket>();
	let alpnProtocol: tls.TLSSocket['alpnProtocol'] | undefined;
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
	}, socket => {
		alpnProtocol = socket.alpnProtocol ?? undefined;
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
		socket.resume();
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const secureConnectionPromise = pEvent(server, 'secureConnection') as Promise<tls.TLSSocket>;
		const request = got.stream(`https://localhost:${port}`, {
			http2: true,
			agent: {
				http2: false,
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		});
		const requestClosePromise = pEvent(request, 'close');

		request.resume();
		const socket = await secureConnectionPromise;
		const socketClosePromise = pEvent(socket, 'close');

		request.destroy();

		await requestClosePromise;
		await socketClosePromise;
		t.is(alpnProtocol, 'h2');
		t.true(socket.destroyed);
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 supports explicit h2session option', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});
	const session = http2.connect(server.url, {
		rejectUnauthorized: false,
	});

	try {
		await pEvent(session, 'remoteSettings');
		t.is(server.sessions.size, 1);

		const {body} = await got(server.url, {
			http2: true,
			hooks: {
				beforeRequest: [
					(options: NormalizedOptions) => {
						options.h2session = session;
					},
				],
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, 'ok');
		t.is(server.sessions.size, 1);
		t.false(session.destroyed);
	} finally {
		session.destroy();
		await server.close();
	}
});

test('http2 supports h2c with explicit h2session option', async t => {
	const server = http2.createServer();

	server.on('stream', (stream: ServerHttp2Stream, headers) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
			'content-type': 'application/json',
		});
		stream.end(JSON.stringify({
			path: headers[':path'],
			scheme: headers[':scheme'],
		}));
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const {port} = server.address() as net.AddressInfo;
	const url = `http://localhost:${port}/h2c`;
	const session = http2.connect(`http://localhost:${port}`);

	try {
		const {body} = await got(url, {
			hooks: {
				beforeRequest: [
					(options: NormalizedOptions) => {
						options.h2session = session;
					},
				],
			},
		});

		t.deepEqual(JSON.parse(body) as Record<string, string>, {
			path: '/h2c',
			scheme: 'http',
		});
	} finally {
		session.destroy();

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 supports IPv6 h2c URLs with explicit h2session option', async t => {
	const server = http2.createServer((request, response) => {
		response.end(request.url);
	});

	let port: number;

	try {
		port = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '::1', () => {
				server.off('error', reject);
				resolve((server.address() as net.AddressInfo).port);
			});
		});
	} catch (error: any) {
		if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' || error.code === 'EPERM') {
			t.pass('IPv6 loopback is not available');
			return;
		}

		throw error;
	}

	const url = `http://[::1]:${port}/h2c-ipv6`;
	const session = http2.connect(`http://[::1]:${port}`);

	try {
		const {body} = await got(url, {
			http2: true,
			hooks: {
				beforeRequest: [
					(options: NormalizedOptions) => {
						options.h2session = session;
					},
				],
			},
		});

		t.is(body, '/h2c-ipv6');
	} finally {
		session.destroy();

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 clears explicit h2session on cross-origin redirects', async t => {
	let firstServerRequests = 0;
	let secondServerRequests = 0;
	const firstServer = http2.createServer();
	const secondServer = http2.createServer();
	const sessions = new Map<string, http2.ClientHttp2Session>();

	const listen = async (server: http2.Http2Server) => new Promise<number>(resolve => {
		server.listen(0, 'localhost', () => {
			resolve((server.address() as net.AddressInfo).port);
		});
	});
	const close = async (server: http2.Http2Server) => new Promise<void>((resolve, reject) => {
		server.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
	const getSession = (origin: string) => {
		const cachedSession = sessions.get(origin);
		if (cachedSession && !cachedSession.destroyed) {
			return cachedSession;
		}

		const session = http2.connect(origin);
		sessions.set(origin, session);
		return session;
	};

	const firstPort = await listen(firstServer);
	const secondPort = await listen(secondServer);
	const firstUrl = `http://localhost:${firstPort}`;
	const secondUrl = `http://localhost:${secondPort}`;

	firstServer.on('stream', (stream: ServerHttp2Stream, headers) => {
		firstServerRequests++;

		if (headers[':path'] === '/start') {
			stream.respond({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':status': 302,
				location: `${secondUrl}/target`,
			});
			stream.end();
			return;
		}

		if (headers[':path'] === '/hook-start') {
			stream.respond({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':status': 302,
				location: `${firstUrl}/same-origin-target`,
			});
			stream.end();
			return;
		}

		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('wrong-origin');
	});
	secondServer.on('stream', (stream: ServerHttp2Stream) => {
		secondServerRequests++;
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const hooks = {
			beforeRequest: [
				(options: NormalizedOptions) => {
					options.h2session ??= getSession(options.url!.origin);
				},
			],
			beforeRedirect: [
				(options: NormalizedOptions) => {
					if (options.url!.pathname === '/same-origin-target') {
						options.url = new URL(`${secondUrl}/hook-target`);
					}
				},
			],
		};
		const {body} = await got(`${firstUrl}/start`, {
			hooks,
		});

		t.is(body, 'ok');

		const hookRedirectResponse = await got(`${firstUrl}/hook-start`, {
			hooks,
		});

		t.is(hookRedirectResponse.body, 'ok');
		t.is(firstServerRequests, 2);
		t.is(secondServerRequests, 2);
	} finally {
		for (const session of sessions.values()) {
			session.destroy();
		}

		await close(firstServer);
		await close(secondServer);
	}
});

test('http2 supports IPv6 HTTPS authorities', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<http2.ServerHttp2Session>();

	server.on('session', session => {
		sessions.add(session);
		session.once('close', () => {
			sessions.delete(session);
		});
	});
	server.on('stream', (stream: ServerHttp2Stream, headers) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end(String(headers[':authority']));
	});

	let port: number;

	try {
		port = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '::1', () => {
				server.off('error', reject);
				resolve((server.address() as net.AddressInfo).port);
			});
		});
	} catch (error: any) {
		if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' || error.code === 'EPERM') {
			t.pass('IPv6 loopback is not available');
			return;
		}

		throw error;
	}

	try {
		const {body} = await got(`https://[::1]:${port}`, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, `[::1]:${port}`);
	} finally {
		for (const session of sessions) {
			session.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 rejects pseudo-headers in request headers', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<http2.ServerHttp2Session>();

	server.on('session', session => {
		sessions.add(session);
		session.once('close', () => {
			sessions.delete(session);
		});
	});
	server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const gotPromise = got(`https://localhost:${port}/expected`, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':path': '/evil',
			},
		});

		await t.throwsAsync(gotPromise, {
			message: 'HTTP/2 pseudo-headers are not supported in `options.headers`: :path',
		});
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 connection reuse with default agent', async t => {
	const sessions: Array<NonNullable<ServerHttp2Stream['session']>> = [];
	const streamClosedPromises: Array<Promise<unknown>> = [];
	const server = await createHttp2TestServer((stream, headers) => {
		sessions.push(stream.session!);
		streamClosedPromises.push(pEvent(stream, 'close'));
		const isCreatedResponse = headers[':path'] === '/201';
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': isCreatedResponse ? 201 : 200,
		});
		stream.end(isCreatedResponse ? 'Created' : 'OK');
	});

	try {
		const options = {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		};
		const response1 = await got(`${server.url}/200`, options);
		await streamClosedPromises[0];
		const response2 = await got(`${server.url}/201`, options);

		t.is(response1.statusCode, 200);
		t.is(response2.statusCode, 201);
		t.is(server.sessions.size, 1);
		t.true(sessions[0] === sessions[1]);
	} finally {
		await server.close();
	}
});

test('http2 cold concurrent requests share default agent session', async t => {
	const sessions: Array<NonNullable<ServerHttp2Stream['session']>> = [];
	const server = await createHttp2TestServer(stream => {
		sessions.push(stream.session!);
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const options = {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		};
		const responses = await Promise.all([
			got(`${server.url}/1`, options),
			got(`${server.url}/2`, options),
			got(`${server.url}/3`, options),
			got(`${server.url}/4`, options),
			got(`${server.url}/5`, options),
		]);

		t.deepEqual(responses.map(response => response.body), ['ok', 'ok', 'ok', 'ok', 'ok']);
		t.is(server.sessions.size, 1);
		t.true(sessions.every(session => session === sessions[0]));
	} finally {
		await server.close();
	}
});

test('http2 reports reusedSocket for pooled sessions', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const options = {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		};
		const firstResponse = await got(`${server.url}/first`, options);
		const secondResponse = await got(`${server.url}/second`, options);

		t.false(firstResponse.request.reusedSocket);
		t.true(secondResponse.request.reusedSocket);
	} finally {
		await server.close();
	}
});

test('http2 session pool distinguishes checkServerIdentity function identity', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<http2.ServerHttp2Session>();

	server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});
	server.on('session', session => {
		sessions.add(session);
		session.once('close', () => {
			sessions.delete(session);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const {port} = server.address() as net.AddressInfo;
	const url = `https://localhost:${port}`;
	const createCheckServerIdentity = (error: Error | undefined) => () => error;

	try {
		const options = {
			http2: true,
			https: {
				certificateAuthority: certificate.certificate,
				checkServerIdentity: createCheckServerIdentity(undefined),
			},
			retry: {
				limit: 0,
			},
		};

		t.is((await got(url, options)).body, 'ok');
		await t.throwsAsync(got(url, {
			...options,
			https: {
				...options.https,
				checkServerIdentity: createCheckServerIdentity(new Error('CUSTOM_ERROR')),
			},
		}), {
			message: 'CUSTOM_ERROR',
		});
	} finally {
		for (const session of sessions) {
			session.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 does not exceed maxConcurrentStreams on pooled sessions', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		settings: {
			maxConcurrentStreams: 1,
		},
	});
	const sessions = new Set<NonNullable<ServerHttp2Stream['session']>>();
	const activeStreams = new Map<NonNullable<ServerHttp2Stream['session']>, number>();
	let maxActiveStreamsPerSession = 0;
	let releaseSlowStream!: () => void;
	const slowStreamStarted = new Promise<void>(resolve => {
		server.on('stream', (stream: ServerHttp2Stream, headers) => {
			const session = stream.session!;
			sessions.add(session);
			activeStreams.set(session, (activeStreams.get(session) ?? 0) + 1);
			maxActiveStreamsPerSession = Math.max(maxActiveStreamsPerSession, activeStreams.get(session)!);
			stream.once('close', () => {
				activeStreams.set(session, activeStreams.get(session)! - 1);
			});

			stream.respond({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':status': 200,
			});

			if (headers[':path'] === '/slow') {
				releaseSlowStream = () => {
					stream.end('slow');
				};

				resolve();
				return;
			}

			stream.end('fast');
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const url = `https://localhost:${port}`;
		const options = {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		};
		const slowResponsePromise = got(`${url}/slow`, options);
		await slowStreamStarted;
		const fastResponsePromise = got(`${url}/fast`, options);

		await new Promise(resolve => {
			setTimeout(resolve, 50);
		});

		releaseSlowStream();
		const [slowResponse, fastResponse] = await Promise.all([slowResponsePromise, fastResponsePromise]);

		t.is(slowResponse.body, 'slow');
		t.is(fastResponse.body, 'fast');
		t.is(maxActiveStreamsPerSession, 1);
	} finally {
		for (const session of sessions) {
			session.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 does not reuse sessions across different checkServerIdentity options', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<http2.ServerHttp2Session>();

	server.on('session', session => {
		sessions.add(session);
		session.once('close', () => {
			sessions.delete(session);
		});
	});
	server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	let acceptedCheckCount = 0;
	let rejectedCheckCount = 0;

	try {
		const {port} = server.address() as net.AddressInfo;
		const url = `https://localhost:${port}`;
		const certificateAuthority = certificate.certificate;

		t.is((await got(url, {
			http2: true,
			https: {
				certificateAuthority,
				checkServerIdentity() {
					acceptedCheckCount++;
					return undefined;
				},
			},
		})).body, 'ok');

		await t.throwsAsync(got(url, {
			http2: true,
			https: {
				certificateAuthority,
				checkServerIdentity() {
					rejectedCheckCount++;
					return new Error('Rejected by checkServerIdentity');
				},
			},
		}), {
			message: 'Rejected by checkServerIdentity',
		});

		t.is(acceptedCheckCount, 1);
		t.is(rejectedCheckCount, 1);
	} finally {
		for (const session of sessions) {
			session.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 agent false reuses the ALPN socket for the current request', async t => {
	let secureConnectionCount = 0;
	let sessionClose: Promise<unknown> | undefined;
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	server.server.on('secureConnection', () => {
		secureConnectionCount++;
	});
	server.server.once('session', session => {
		sessionClose = pEvent(session, 'close');
	});

	try {
		const {body} = await got(server.url, {
			http2: true,
			agent: {
				http2: false,
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, 'ok');
		t.is(secureConnectionCount, 1);
		await sessionClose;
		t.is(server.sessions.size, 0);
	} finally {
		await server.close();
	}
});

test('http2 abort closes only the affected stream', async t => {
	let slowStreamReceived!: () => void;
	const slowStreamReceivedPromise = new Promise<void>(resolve => {
		slowStreamReceived = resolve;
	});
	const server = await createHttp2TestServer((stream, headers) => {
		if (headers[':path'] === '/slow') {
			slowStreamReceived();
			stream.resume();
			return;
		}

		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});
	const session = http2.connect(server.url, {
		rejectUnauthorized: false,
	});
	const controller = new AbortController();

	try {
		const options = {
			http2: true,
			hooks: {
				beforeRequest: [
					(options: NormalizedOptions) => {
						options.h2session = session;
					},
				],
			},
			https: {
				rejectUnauthorized: false,
			},
		};
		const slowRequest = got(`${server.url}/slow`, {
			...options,
			signal: controller.signal,
		});
		const fastRequest = got(`${server.url}/fast`, options);

		await slowStreamReceivedPromise;
		controller.abort();

		await t.throwsAsync(slowRequest, {
			code: 'ERR_ABORTED',
		});
		t.is((await fastRequest).body, 'ok');
		t.false(session.destroyed);
	} finally {
		session.destroy();
		await server.close();
	}
});

test('http2 ALPN uses createConnection', async t => {
	let createConnectionCount = 0;
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const {port} = new URL(server.url);
		const {body} = await got(`https://example.invalid:${port}`, {
			http2: true,
			agent: {
				http2: false,
			},
			createConnection(options) {
				createConnectionCount++;
				const alpnProtocols = 'ALPNProtocols';

				return tls.connect(Number(options.port), 'localhost', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername: 'localhost',
				});
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, 'ok');
		t.is(createConnectionCount, 1);
	} finally {
		await server.close();
	}
});

test('http2 ALPN createConnection does not reuse pooled session', async t => {
	const firstServer = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('first');
	});
	let secondSessionClose: Promise<unknown> | undefined;
	const secondServer = await createHttp2TestServer(stream => {
		secondSessionClose = pEvent(stream.session!, 'close');
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('second');
	});

	try {
		const firstUrl = firstServer.url;
		const secondPort = new URL(secondServer.url).port;

		t.is((await got(firstUrl, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		})).body, 'first');

		t.is((await got(firstUrl, {
			http2: true,
			createConnection() {
				const alpnProtocols = 'ALPNProtocols';

				return tls.connect(Number(secondPort), 'localhost', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername: 'localhost',
				});
			},
			https: {
				rejectUnauthorized: false,
			},
		})).body, 'second');

		await secondSessionClose;

		t.is((await got(firstUrl, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		})).body, 'first');
	} finally {
		await firstServer.close();
		await secondServer.close();
	}
});

test('http2 rejects when session closes before settings', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
	}, socket => {
		socket.end();
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		await t.throwsAsync(got(`https://127.0.0.1:${port}`, {
			http2: true,
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		}), {
			code: 'ERR_GOT_REQUEST_ERROR',
			message: 'The HTTP/2 session closed before settings were received',
		});
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 session pool distinguishes lookup function identity', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const createServer = async (host: string, port?: number) => {
		const server = http2.createSecureServer({
			key: certificate.serviceKey,
			cert: certificate.certificate,
		});
		const sessions = new Set<http2.ServerHttp2Session>();

		server.on('stream', (stream: ServerHttp2Stream) => {
			stream.respond({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				':status': 200,
			});
			stream.end(host);
		});
		server.on('session', session => {
			sessions.add(session);
			session.once('close', () => {
				sessions.delete(session);
			});
		});

		await new Promise<void>(resolve => {
			server.listen(port ?? 0, host, resolve);
		});

		return {server, sessions};
	};

	const ipv4Server = await createServer('127.0.0.1');
	const {port} = ipv4Server.server.address() as net.AddressInfo;
	const ipv6Server = await createServer('::1', port);
	const createLookup = (address: string, family: 4 | 6) => ((_hostname: string, options: any, callback: any) => {
		if (options.all) {
			callback(null, [{address, family}]);
			return;
		}

		callback(null, address, family);
	}) as LookupFunction;
	const url = `https://lookup-session.invalid:${port}`;
	const baseOptions = {
		http2: true,
		https: {
			rejectUnauthorized: false,
		},
		retry: {
			limit: 0,
		},
	};

	try {
		t.is((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('127.0.0.1', 4),
		})).body, '127.0.0.1');
		t.is((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('::1', 6),
		})).body, '::1');
	} finally {
		for (const session of ipv6Server.sessions) {
			session.destroy();
		}

		for (const session of ipv4Server.sessions) {
			session.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			ipv6Server.server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			ipv4Server.server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 ALPN ignores cached protocols when using createConnection', async t => {
	const http1Server = await new Promise<https.Server>((resolve, reject) => {
		pem.createCertificate({days: 1, selfSigned: true}, (error, certificate) => {
			if (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			const server = https.createServer({
				key: certificate.serviceKey,
				cert: certificate.certificate,
			}, (_request, response) => {
				response.end('http1');
			});

			server.listen(0, 'localhost', () => {
				resolve(server);
			});
		});
	});
	const http2Server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('h2');
	});

	try {
		const http1Port = (http1Server.address() as net.AddressInfo).port;
		const http2Port = new URL(http2Server.url).port;
		const alpnProtocols = 'ALPNProtocols';
		const url = 'https://example.invalid';
		const options = {
			http2: true,
			createConnection({servername}: NativeRequestOptions) {
				return tls.connect(http1Port, 'localhost', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername,
				});
			},
			https: {
				rejectUnauthorized: false,
			},
		};

		t.is((await got(url, options)).body, 'http1');
		t.is((await got(url, {
			...options,
			createConnection({servername}: NativeRequestOptions) {
				return tls.connect(Number(http2Port), 'localhost', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername,
				});
			},
		})).body, 'h2');
	} finally {
		await new Promise<void>((resolve, reject) => {
			http1Server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
		await http2Server.close();
	}
});

test('http2 ALPN protocol cache distinguishes lookup function identity', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const http2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});

	http2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('h2');
	});

	await new Promise<void>(resolve => {
		http2Server.listen(0, '127.0.0.1', resolve);
	});

	const {port} = http2Server.address() as net.AddressInfo;
	const http1Server = https.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	}, (_request, response) => {
		response.end('http1');
	});

	await new Promise<void>(resolve => {
		http1Server.listen(port, '::1', resolve);
	});

	const createLookup = (address: string, family: 4 | 6) => ((_hostname: string, options: any, callback: any) => {
		if (options.all) {
			callback(null, [{address, family}]);
			return;
		}

		callback(null, address, family);
	}) as LookupFunction;
	const url = `https://lookup-alpn.invalid:${port}`;
	const baseOptions = {
		http2: true,
		agent: {
			http2: false as const,
		},
		https: {
			rejectUnauthorized: false,
		},
		retry: {
			limit: 0,
		},
	};

	try {
		t.is((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('127.0.0.1', 4),
		})).body, 'h2');
		t.is((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('::1', 6),
		})).body, 'http1');
	} finally {
		await new Promise<void>((resolve, reject) => {
			http1Server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			http2Server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 ALPN protocol cache distinguishes DNS lookup IP family', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const http2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});

	http2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('h2');
	});

	await new Promise<void>(resolve => {
		http2Server.listen(0, '127.0.0.1', resolve);
	});

	const {port} = http2Server.address() as net.AddressInfo;
	const http1Server = https.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	}, (_request, response) => {
		response.end('http1');
	});

	await new Promise<void>(resolve => {
		http1Server.listen(port, '::1', resolve);
	});

	const dnsLookup = ((_hostname: string, options: any, callback: any) => {
		const family = options.family === 6 ? 6 : 4;
		const address = family === 6 ? '::1' : '127.0.0.1';

		if (options.all) {
			callback(null, [{address, family}]);
			return;
		}

		callback(null, address, family);
	}) as LookupFunction;
	const url = `https://lookup-family.invalid:${port}`;
	const baseOptions = {
		http2: true,
		agent: {
			http2: false as const,
		},
		dnsLookup,
		https: {
			rejectUnauthorized: false,
		},
		retry: {
			limit: 0,
		},
	};

	try {
		t.is((await got(url, {
			...baseOptions,
			dnsLookupIpVersion: 4 as const,
		})).body, 'h2');
		t.is((await got(url, {
			...baseOptions,
			dnsLookupIpVersion: 6 as const,
		})).body, 'http1');
	} finally {
		await new Promise<void>((resolve, reject) => {
			http1Server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			http2Server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 ALPN protocol cache preserves protocol order', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		allowHTTP1: true,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNCallback: ({protocols}) => protocols[0],
	});

	server.on('request', (request, response) => {
		if (request.httpVersionMajor !== 1) {
			return;
		}

		response.end(request.httpVersion);
	});

	server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('2.0');
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const url = `https://localhost:${port}`;
		const baseOptions = {
			http2: true,
			agent: {
				http2: false as const,
			},
			https: {
				rejectUnauthorized: false,
			},
		};

		t.is((await got(url, {
			...baseOptions,
			https: {
				...baseOptions.https,
				alpnProtocols: ['h2', 'http/1.1'],
			},
		})).body, '2.0');
		t.is((await got(url, {
			...baseOptions,
			https: {
				...baseOptions.https,
				alpnProtocols: ['http/1.1', 'h2'],
			},
		})).body, '1.1');
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 ALPN protocol cache evicts old origins', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const h2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});

	h2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('h2');
	});

	await new Promise<void>(resolve => {
		h2Server.listen(0, '127.0.0.1', resolve);
	});

	const {port} = h2Server.address() as net.AddressInfo;
	const dnsLookup = ((_hostname: string, options: any, callback: any) => {
		if (options.all) {
			callback(null, [{address: '127.0.0.1', family: 4}]);
			return;
		}

		callback(null, '127.0.0.1', 4);
	}) as LookupFunction;

	const options = {
		http2: true,
		agent: {
			http2: false as const,
		},
		dnsLookup,
		https: {
			rejectUnauthorized: false,
		},
		retry: {
			limit: 0,
		},
	};

	for (let index = 0; index < 101; index++) {
		// eslint-disable-next-line no-await-in-loop
		t.is((await got(`https://cache-${index}.invalid:${port}`, options)).body, 'h2');
	}

	await new Promise<void>((resolve, reject) => {
		h2Server.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});

	const http1Server = https.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	}, (_request, response) => {
		response.end('http1');
	});

	await new Promise<void>(resolve => {
		http1Server.listen(port, '127.0.0.1', resolve);
	});

	try {
		t.is((await got(`https://cache-0.invalid:${port}`, options)).body, 'http1');
	} finally {
		await new Promise<void>((resolve, reject) => {
			http1Server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test('http2 ALPN uses the default HTTPS port', async t => {
	let createConnectionCount = 0;
	let observedPort: string | number | undefined;
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const localPort = new URL(server.url).port;
		const {body} = await got('https://example.com', {
			http2: true,
			agent: {
				http2: false,
			},
			createConnection(options) {
				createConnectionCount++;
				observedPort = options.port ?? undefined;
				const alpnProtocols = 'ALPNProtocols';

				return tls.connect(Number(localPort), 'localhost', {
					[alpnProtocols]: ['h2', 'http/1.1'],
					rejectUnauthorized: false,
					servername: 'localhost',
				});
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, 'ok');
		t.is(createConnectionCount, 1);
		t.is(observedPort, 443);
	} finally {
		await server.close();
	}
});

test('http2 ALPN still runs when HTTPS agent is false', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const {body} = await got(server.url, {
			http2: true,
			agent: {
				https: false,
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, 'ok');
	} finally {
		await server.close();
	}
});

test('http2 uses native HTTP/1.1 path with custom HTTPS agent', withHttpsServer(), async (t, server, got) => {
	let secureConnectionCount = 0;

	server.get('/', (request, response) => {
		response.end(request.httpVersion);
	});
	server.https.on('secureConnection', () => {
		secureConnectionCount++;
	});

	const localPort = new URL(server.url).port;
	const agent = new https.Agent({
		lookup(_hostname, options, callback) {
			if (options.all) {
				callback(null, [{address: '127.0.0.1', family: 4}]);
				return;
			}

			callback(null, '127.0.0.1', 4);
		},
	});

	try {
		const {body} = await got(`https://example.invalid:${localPort}/`, {
			http2: true,
			agent: {
				https: agent,
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, '1.1');
		t.is(secureConnectionCount, 1);
	} finally {
		agent.destroy();
	}
});

test('http2 custom request receives native HTTPS agent option', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const agent = new https.Agent();
	let receivedAgent: NativeRequestOptions['agent'];

	try {
		const {body} = await got({
			http2: true,
			agent: {
				https: agent,
			},
			request(url, options, callback) {
				receivedAgent = options.agent;
				return https.request(url, options, callback);
			},
		});

		t.is(body, 'ok');
		t.is(receivedAgent, agent);
	} finally {
		agent.destroy();
	}
});

test('http2 custom HTTPS agent only advertises HTTP/1.1', async t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		allowHTTP1: true,
	}, (request, response) => {
		response.end(request.httpVersion);
	});
	let sawHttp2Stream = false;
	let alpnProtocol: tls.TLSSocket['alpnProtocol'] | undefined;

	server.on('stream', stream => {
		sawHttp2Stream = true;
		stream.close();
	});

	server.on('secureConnection', socket => {
		alpnProtocol = socket.alpnProtocol ?? undefined;
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const agent = new https.Agent();

	try {
		const {port} = server.address() as net.AddressInfo;
		const {body} = await got(`https://localhost:${port}`, {
			http2: true,
			agent: {
				https: agent,
			},
			https: {
				rejectUnauthorized: false,
			},
		});

		t.is(body, '1.1');
		t.false(sawHttp2Stream);
		t.is(alpnProtocol, 'http/1.1');
	} finally {
		agent.destroy();

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});

test.serial('deprecated `rejectUnauthorized` option', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.throwsAsync(got({
		// @ts-expect-error Testing purposes
		rejectUnauthorized: false,
	}), {
		message: 'Unexpected option: rejectUnauthorized',
	});
});

test.serial('non-deprecated `rejectUnauthorized` option', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	(async () => {
		const warning = await pEvent(process, 'warning') as Error;
		t.not(warning.name, 'DeprecationWarning');
	})();

	await got({
		https: {
			rejectUnauthorized: false,
		},
	});

	t.pass();
});

test('client certificate', withHttpsServer(), async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate,
		});
	});

	const clientCsrResult = await createCsr({commonName: 'client'});
	const clientResult = await createCertificate({
		csr: clientCsrResult.csr,
		clientKey: clientCsrResult.clientKey,
		serviceKey: (server as any).caKey,
		serviceCertificate: (server as any).caCert,
	});
	// eslint-disable-next-line prefer-destructuring
	const clientKey = clientResult.clientKey;
	const clientCert = clientResult.certificate;

	const response = await got({
		https: {
			key: clientKey,
			certificate: clientCert,
		},
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid client certificate (self-signed)', withHttpsServer(), async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate,
		});
	});

	const clientCsrResult = await createCsr({commonName: 'other-client'});
	const clientResult = await createCertificate({
		csr: clientCsrResult.csr,
		clientKey: clientCsrResult.clientKey,
		selfSigned: true,
	});
	// eslint-disable-next-line prefer-destructuring
	const clientKey = clientResult.clientKey;
	const clientCert = clientResult.certificate;

	const response = await got({
		https: {
			key: clientKey,
			certificate: clientCert,
		},
	}).json<{
		authorized: boolean;
	}>();

	t.false(response.authorized);
});

test('invalid client certificate (other CA)', withHttpsServer(), async (t, server, got) => {
	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate,
		});
	});

	const caCsrResult = await createCsr({commonName: 'other-authority'});
	const caResult = await createCertificate({
		csr: caCsrResult.csr,
		clientKey: caCsrResult.clientKey,
		selfSigned: true,
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const clientCsrResult = await createCsr({commonName: 'other-client'});
	const clientResult = await createCertificate({
		csr: clientCsrResult.csr,
		clientKey: clientCsrResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert,
	});
	// eslint-disable-next-line prefer-destructuring
	const clientKey = clientResult.clientKey;
	const clientCert = clientResult.certificate;

	const response = await got({
		https: {
			key: clientKey,
			certificate: clientCert,
		},
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.false(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'other-client');
	t.is(response.peerCertificate.issuer.CN, 'other-authority');
});

test('key passphrase', withHttpsServer(), async (t, server, got) => {
	// Ignore macOS for now as it fails with some internal OpenSSL error.
	if (process.platform === 'darwin') {
		t.pass();
		return;
	}

	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate,
		});
	});

	const {key: clientKey} = await createPrivateKey(2048, {
		cipher: 'aes256',
		password: 'randomPassword',
	});
	const clientCsrResult = await createCsr({
		// eslint-disable-next-line object-shorthand
		clientKey: clientKey,
		clientKeyPassword: 'randomPassword',
		commonName: 'client',
	});
	const clientResult = await createCertificate({
		csr: clientCsrResult.csr,
		clientKey: clientCsrResult.clientKey,
		clientKeyPassword: 'randomPassword',
		serviceKey: (server as any).caKey,
		serviceCertificate: (server as any).caCert,
	});
	const clientCert = clientResult.certificate;

	const response = await got({
		https: {
			key: clientKey,
			passphrase: 'randomPassword',
			certificate: clientCert,
		},
	}).json<{
		authorized: boolean;
		peerCertificate: {
			subject: {CN: string};
			issuer: {CN: string};
		};
	}>();

	t.true(response.authorized);
	t.is(response.peerCertificate.subject.CN, 'client');
	t.is(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid key passphrase', withHttpsServer(), async (t, server, got) => {
	// Ignore macOS for now as it fails with some internal OpenSSL error.
	if (process.platform === 'darwin') {
		t.pass();
		return;
	}

	server.get('/', (request, response) => {
		const peerCertificate = (request.socket as any).getPeerCertificate(true);
		peerCertificate.issuerCertificate.issuerCertificate = undefined; // Circular structure

		response.json({
			authorized: (request.socket as any).authorized,
			peerCertificate,
		});
	});

	const {key: clientKey} = await createPrivateKey(2048, {
		cipher: 'aes256',
		password: 'randomPassword',
	});
	const clientCsrResult = await createCsr({
		// eslint-disable-next-line object-shorthand
		clientKey: clientKey,
		clientKeyPassword: 'randomPassword',
		commonName: 'client',
	});
	const clientResult = await createCertificate({
		csr: clientCsrResult.csr,
		clientKey: clientCsrResult.clientKey,
		clientKeyPassword: 'randomPassword',
		serviceKey: (server as any).caKey,
		serviceCertificate: (server as any).caCert,
	});
	const clientCert = clientResult.certificate;

	const request = got({
		https: {
			key: clientKey,
			passphrase: 'wrongPassword',
			certificate: clientCert,
		},
	});

	const {code}: NodeJS.ErrnoException = (await t.throwsAsync(request));
	t.true(code === 'ERR_OSSL_BAD_DECRYPT' || code === 'ERR_OSSL_EVP_BAD_DECRYPT', code);
});

// Use TLS 1.3 ciphers that are stable across Node.js versions
// TLS 1.3 ciphers work best because they're consistently supported
const tlsCiphers = tls.getCiphers().map(cipher => cipher.toUpperCase()).filter(cipher => cipher.startsWith('TLS_'));

// Pick ciphers that exist in both Node.js 20 and 24
// TLS_AES_128_GCM_SHA256 and TLS_AES_256_GCM_SHA384 are always available in TLS 1.3
const stableCiphers = [
	tlsCiphers.find(c => c === 'TLS_AES_128_GCM_SHA256')!,
	tlsCiphers.find(c => c === 'TLS_AES_256_GCM_SHA384')!,
	tlsCiphers.find(c => c === 'TLS_CHACHA20_POLY1305_SHA256')!,
].filter(Boolean);

test('https request with `ciphers` option', withHttpsServer({ciphers: stableCiphers.join(':'), minVersion: 'TLSv1.3'}), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({
			cipher: (request.socket as any).getCipher().name,
		});
	});

	const response = await got({
		https: {
			ciphers: stableCiphers[0],
			minVersion: 'TLSv1.3',
		},
	}).json<{cipher: string}>();

	t.is(response.cipher, stableCiphers[0]!);
});

test('https request with `honorCipherOrder` option', withHttpsServer({ciphers: `${stableCiphers[0]!}:${stableCiphers[1]!}`, minVersion: 'TLSv1.3'}), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({
			cipher: (request.socket as any).getCipher().name,
		});
	});

	const response = await got({
		https: {
			ciphers: `${stableCiphers[1]!}:${stableCiphers[0]!}`,
			honorCipherOrder: true,
			minVersion: 'TLSv1.3',
		},
	}).json<{cipher: string}>();

	t.is(response.cipher, stableCiphers[0]!);
});

test('https request with `minVersion` option', withHttpsServer({maxVersion: 'TLSv1.2'}), async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({
			version: (request.socket as any).getCipher().version,
		});
	});

	const request = got({
		https: {
			minVersion: 'TLSv1.3',
		},
	});

	await t.throwsAsync(request, {
		code: 'EPROTO',
	});
});
