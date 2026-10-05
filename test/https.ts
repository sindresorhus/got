import http2, {type ClientHttp2Session, type ServerHttp2Stream} from 'node:http2';
import type {IncomingMessage} from 'node:http';
import https from 'node:https';
import net, {type LookupFunction} from 'node:net';
import process from 'node:process';
import tls, {type DetailedPeerCertificate} from 'node:tls';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {promisify} from 'node:util';
import pem from 'pem';
import got, {type NativeRequestOptions, type NormalizedOptions} from '../source/index.js';
import {Http2Agent, request as http2Request} from '../source/core/utils/http2-client.js';
import closed from './helpers/closed.js';
import {rejects} from './helpers/rejects.js';
import {onceValue} from './helpers/once-value.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import {withHttpsServer} from './helpers/with-server.js';
import type {CreatePrivateKey, CreateCsr, CreateCertificate} from './types/pem.js';

const createPrivateKey = promisify(pem.createPrivateKey as CreatePrivateKey);
const createCsr = promisify(pem.createCSR as CreateCsr);
const createCertificate = promisify(pem.createCertificate as CreateCertificate);
const ipv6UnavailableErrorCodes = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPERM']);

const isIpv6UnavailableError = (error: unknown): boolean => ipv6UnavailableErrorCodes.has((error as NodeJS.ErrnoException).code ?? '');

// The counters Got keeps on the session it pools. They are not optional, so a rename or a
// removal fails the assertion instead of reading as zero.
type SessionWithCounters = ClientHttp2Session & {
	currentStreamCount: number;
	reservedStreamCount: number;
};

const closeServer = async (server: net.Server): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		server.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
};

const collectHttp2ResponseBody = async (request: ReturnType<typeof http2Request>): Promise<string> => new Promise((resolve, reject) => {
	request.once('response', response => {
		let body = '';
		response.setEncoding('utf8');
		response.on('data', chunk => {
			body += chunk as string;
		});
		response.once('end', () => {
			resolve(body);
		});
		response.once('error', reject);
	});
	request.once('error', reject);
	request.end();
});

test('http2 native requests append header values', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(String(headers['x-values']));
	});
	t.after(async () => {
		await server.close();
	});

	const request = http2Request(server.url, {rejectUnauthorized: false, headers: {'x-values': 'first'}});
	assert.strictEqual(request.appendHeader('x-values', 'second'), request);
	assert.strictEqual(await collectHttp2ResponseBody(request), 'first, second');
});

test('http2 native requests accept Fetch Headers through setHeaders', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(String(headers['x-value']));
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {rejectUnauthorized: false});
	assert.strictEqual(request.setHeaders(new Headers({'x-value': 'sent'})), request);
	assert.strictEqual(await collectHttp2ResponseBody(request), 'sent');
});

test('http2 setHeaders replaces Map fields through the request event and retains unrelated fields', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(JSON.stringify(headers));
	});
	t.after(async () => {
		await server.close();
	});
	const values = Object.freeze(['first', 'second']);
	const headers = await got(server.url, {
		http2: true,
		https: {rejectUnauthorized: false},
		headers: {'x-replaced': 'old', 'x-retained': 'kept'},
	}).on('request', request => {
		assert.strictEqual(request.setHeaders(new Map<string, string | number | readonly string[]>([
			['X-Replaced', 'new'],
			['x-values', values],
			['x-number', 42],
		])), request);
	}).json<Record<string, string>>();

	assert.strictEqual(headers['x-replaced'], 'new');
	assert.strictEqual(headers['x-retained'], 'kept');
	assert.strictEqual(headers['x-values'], 'first, second');
	assert.strictEqual(headers['x-number'], '42');
	assert.deepStrictEqual(values, ['first', 'second']);
});

test('http2 setHeaders preserves distinct Set-Cookie values from Fetch Headers', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(JSON.stringify(headers['set-cookie']));
	});
	t.after(async () => {
		await server.close();
	});
	const values = ['first=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT', 'second=2'];
	const headers = new Headers();
	for (const value of values) {
		headers.append('set-cookie', value);
	}

	const request = http2Request(server.url, {rejectUnauthorized: false, headers: {'set-cookie': 'replaced=3'}});
	request.setHeaders(headers);
	assert.deepStrictEqual(request.getHeader('set-cookie'), values);
	assert.deepStrictEqual(JSON.parse(await collectHttp2ResponseBody(request)), values);
});

for (const collectionType of ['Headers', 'Map']) {
	test(`http2 setHeaders accepts empty ${collectionType} before sending and rejects it afterward`, async t => {
		const server = await createHttp2TestServer((stream, headers) => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
			stream.end(String(headers['x-value']));
		});
		t.after(async () => {
			await server.close();
		});
		const headers = collectionType === 'Headers' ? new Headers() : new Map<string, string>();
		const request = http2Request(server.url, {rejectUnauthorized: false, headers: {'x-value': 'retained'}});
		assert.strictEqual(request.setHeaders(headers), request);
		const body = collectHttp2ResponseBody(request);
		assert.throws(() => request.setHeaders(headers), {message: 'Cannot set headers after they are sent to the client'});
		assert.strictEqual(await body, 'retained');
	});
}

test('http2 setHeaders validates collections and delegates field validation', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(String(headers['x-value']));
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {rejectUnauthorized: false, headers: {'x-value': 'retained'}});
	// @ts-expect-error Plain objects are not supported by the native setHeaders API.
	assert.throws(() => request.setHeaders({'x-value': 'invalid'}), TypeError);
	assert.throws(() => request.setHeaders(new Map([['invalid name', 'value']])), {code: 'ERR_INVALID_HTTP_TOKEN'});
	assert.throws(() => request.setHeaders(new Map([['x-value', 'invalid\nvalue']])), {code: 'ERR_INVALID_CHAR'});
	assert.strictEqual(await collectHttp2ResponseBody(request), 'retained');
});

test('http2 appendHeader combines arrays and case-insensitive names without changing supplied arrays', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(String(headers['x-values']));
	});
	t.after(async () => {
		await server.close();
	});
	const initialValues = ['first', 'second'];
	const appendedValues = Object.freeze(['third', 'fourth']);
	const request = http2Request(server.url, {rejectUnauthorized: false, headers: {'x-values': initialValues}});
	request.appendHeader('X-Values', appendedValues);
	request.appendHeader('x-VALUES', 'fifth');

	assert.deepStrictEqual(initialValues, ['first', 'second']);
	assert.deepStrictEqual(appendedValues, ['third', 'fourth']);
	assert.deepStrictEqual(request.getHeader('x-values'), ['first', 'second', 'third', 'fourth', 'fifth']);
	assert.strictEqual(await collectHttp2ResponseBody(request), 'first, second, third, fourth, fifth');
});

test('http2 appendHeader creates missing fields and appends to numeric fields through the request event', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(JSON.stringify(headers));
	});
	t.after(async () => {
		await server.close();
	});
	const headers = await got(server.url, {
		http2: true,
		https: {rejectUnauthorized: false},
	}).on('request', request => {
		request.appendHeader('x-single', 'one');
		request.appendHeader('x-array', ['two', 'three']);
		request.setHeader('x-number', 4);
		request.appendHeader('X-Number', 'five');
	}).json<Record<string, string>>();

	assert.strictEqual(headers['x-single'], 'one');
	assert.strictEqual(headers['x-array'], 'two, three');
	assert.strictEqual(headers['x-number'], '4, five');
});

test('http2 appendHeader preserves validation and rejects changes after sending headers', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(String(headers['x-values']));
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {rejectUnauthorized: false, headers: {'x-values': 'first'}});
	assert.throws(() => request.appendHeader('invalid name', 'value'), {code: 'ERR_INVALID_HTTP_TOKEN'});
	assert.throws(() => request.appendHeader('x-values', 'invalid\nvalue'), {code: 'ERR_INVALID_CHAR'});
	assert.strictEqual(request.getHeader('x-values'), 'first');

	const body = collectHttp2ResponseBody(request);
	assert.throws(() => request.appendHeader('x-values', 'second'), {message: 'Cannot set headers after they are sent to the client'});
	assert.strictEqual(await body, 'first');
});

test('http2 preserves a completed response with a known length when the server stops an unfinished upload', async t => {
	const expectedBody = 'complete response';
	const server = await createHttp2TestServer(stream => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200, 'content-length': expectedBody.length});
		stream.end(expectedBody, () => {
			stream.close(http2.constants.NGHTTP2_NO_ERROR);
		});
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {method: 'POST', rejectUnauthorized: false});
	const responsePromise = onceValue<IncomingMessage>(request, 'response');
	request.write('unfinished request');
	const response = await responsePromise;
	await waitForCondition(() => request.socket?.destroyed ?? false, 'The server did not close the upload stream');

	const chunks = await response.toArray();
	assert.strictEqual(chunks.join(''), expectedBody);
	assert.strictEqual(response.complete, true);
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	assert.strictEqual(response.aborted, false);
});

/*
A `NO_ERROR` reset after a complete response is preserved only when the completeness can be
proven. Without a `content-length` the client cannot tell a complete response from a truncated
one, so the truncated reading wins: reporting an error the caller can retry beats handing back a
body that is silently short.
*/
test('http2 reports a lengthless response aborted when the server stops an unfinished upload', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end('complete response without a length', () => {
			stream.close(http2.constants.NGHTTP2_NO_ERROR);
		});
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {method: 'POST', rejectUnauthorized: false});
	const responsePromise = onceValue<IncomingMessage>(request, 'response');
	request.write('unfinished request');
	const response = await responsePromise;
	await waitForCondition(() => request.socket?.destroyed ?? false, 'The server did not close the upload stream');

	// The body is rejected rather than delivered. The code is Node's own, so it is matched
	// instead of its message, which Node may reword.
	await assert.rejects(response.toArray(), {code: 'ERR_STREAM_PREMATURE_CLOSE'});
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	assert.strictEqual(response.aborted, true);
	assert.strictEqual(response.complete, false);
});

test('http2 preserves a backpressured response with a known length when the server stops an unfinished upload', async t => {
	const expectedBody = 'a'.repeat(512 * 1024);
	const server = await createHttp2TestServer(stream => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200, 'content-length': expectedBody.length});
		stream.end(expectedBody, () => {
			stream.close(http2.constants.NGHTTP2_NO_ERROR);
		});
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {method: 'POST', rejectUnauthorized: false});
	const responsePromise = onceValue<IncomingMessage>(request, 'response');
	request.write('unfinished request');
	const response = await responsePromise;
	// Keep the response buffered until the reset has arrived.
	await waitForCondition(() => (response as IncomingMessage & {stream: http2.ClientHttp2Stream}).stream.aborted, 'The server did not stop the unfinished upload');
	const chunks = await response.toArray();

	assert.strictEqual(chunks.join(''), expectedBody);
	assert.strictEqual(response.complete, true);
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	assert.strictEqual(response.aborted, false);
});

test('http2 preserves empty completed responses when the server stops the upload', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 204}, {endStream: true});
		// Closing in the same tick makes nghttp2 1.70+ (Node 24+) drop the queued HEADERS frame, so the client would only ever see the reset.
		setImmediate(() => {
			stream.close(http2.constants.NGHTTP2_NO_ERROR);
		});
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {method: 'POST', rejectUnauthorized: false});
	const responsePromise = onceValue<IncomingMessage>(request, 'response');
	request.write('unfinished request');
	const response = await responsePromise;
	await waitForCondition(() => request.socket?.destroyed ?? false, 'The server did not close the upload stream');

	assert.deepStrictEqual(await response.toArray(), []);
	assert.strictEqual(response.statusCode, 204);
	assert.strictEqual(response.complete, true);
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	assert.strictEqual(response.aborted, false);
});

for (const resetCode of [http2.constants.NGHTTP2_NO_ERROR, http2.constants.NGHTTP2_CANCEL, http2.constants.NGHTTP2_INTERNAL_ERROR]) {
	test(`http2 still marks incomplete responses aborted after reset code ${resetCode}`, async t => {
		const server = await createHttp2TestServer(stream => {
			stream.on('error', () => {});
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200, 'content-length': 100});
			stream.write('partial response', () => {
				stream.close(resetCode);
			});
		});
		t.after(async () => {
			await server.close();
		});
		const request = http2Request(server.url, {method: 'POST', rejectUnauthorized: false});
		const requestErrors: Error[] = [];
		request.on('error', error => {
			requestErrors.push(error);
		});
		const responsePromise = onceValue<IncomingMessage>(request, 'response');
		request.write('unfinished request');
		const response = await responsePromise;
		let abortedEvents = 0;
		response.on('aborted', () => {
			abortedEvents++;
		});
		await waitForCondition(() => request.socket?.destroyed ?? false, 'The server did not reset the stream');

		// eslint-disable-next-line @typescript-eslint/no-deprecated
		assert.strictEqual(response.aborted, true);
		assert.strictEqual(response.complete, false);
		assert.strictEqual(abortedEvents, 1);
		if (resetCode === http2.constants.NGHTTP2_INTERNAL_ERROR) {
			assert.strictEqual(requestErrors.length, 1);
		}
	});
}

test('http2 marks lengthless responses aborted when reset before END_STREAM', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.write('partial response', () => {
			stream.close(http2.constants.NGHTTP2_NO_ERROR);
		});
	});
	t.after(async () => {
		await server.close();
	});
	const request = http2Request(server.url, {method: 'POST', rejectUnauthorized: false});
	request.on('error', () => {});
	const responsePromise = onceValue<IncomingMessage>(request, 'response');
	request.write('unfinished request');
	const response = await responsePromise;
	await waitForCondition(() => request.socket?.destroyed ?? false, 'The server did not reset the stream');

	// eslint-disable-next-line @typescript-eslint/no-deprecated
	assert.strictEqual(response.aborted, true);
	assert.strictEqual(response.complete, false);
});

test('http2 agent starts queued requests when the server increases its stream limit', async t => {
	let firstStream: ServerHttp2Stream | undefined;
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		if (headers[':path'] === '/first') {
			firstStream = stream;
			return;
		}

		stream.end('second');
	});
	server.server.updateSettings({maxConcurrentStreams: 1});
	const agent = new Http2Agent({maxSessions: 1});
	t.after(async () => {
		agent.destroy();
		await server.close();
	});
	const first = http2Request(`${server.url}/first`, {agent, rejectUnauthorized: false});
	first.on('error', () => {});
	const responsePromise = onceValue(first, 'response');
	first.end();
	await responsePromise;

	const second = http2Request(`${server.url}/second`, {agent, rejectUnauthorized: false});
	const bodyPromise = collectHttp2ResponseBody(second);
	await waitForCondition(() => agent.queue.length === 1, 'The second request did not queue');
	await new Promise<void>((resolve, reject) => {
		firstStream!.session!.settings({headerTableSize: 2048}, error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
	assert.strictEqual(agent.queue.length, 1);
	firstStream!.session!.settings({maxConcurrentStreams: 2});

	assert.strictEqual(await withTimeout(bodyPromise, 'The queued request did not start after the stream limit increased'), 'second');
	assert.strictEqual(agent.sessionCount, 1);
	assert.strictEqual(firstStream!.closed, false);
	firstStream!.end();
});

test('http2 agent respects a lowered stream limit while draining its queue', async t => {
	const streams = new Map<string, ServerHttp2Stream>();
	const server = await createHttp2TestServer((stream, headers) => {
		streams.set(headers[':path']!, stream);
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
	});
	server.server.updateSettings({maxConcurrentStreams: 2});
	const agent = new Http2Agent({maxSessions: 1});
	t.after(async () => {
		agent.destroy();
		await server.close();
	});
	const createRequest = (path: string) => {
		const request = http2Request(`${server.url}/${path}`, {agent, rejectUnauthorized: false});
		request.on('error', () => {});
		request.on('response', response => {
			response.resume();
		});
		request.end();
		return request;
	};

	const first = createRequest('first');
	await once(first, 'response');
	const second = createRequest('second');
	await once(second, 'response');
	const third = createRequest('third');
	await waitForCondition(() => agent.queue.length === 1, 'The third request did not queue');
	const session = [...agent.sessions.values()][0]![0]!;
	const settingsPromise = once(session, 'remoteSettings');
	streams.get('/first')!.session!.settings({maxConcurrentStreams: 1});
	await settingsPromise;
	const firstClosed = once(first, 'close');
	streams.get('/first')!.end();
	await firstClosed;
	assert.strictEqual(agent.queue.length, 1);
	assert.strictEqual(streams.has('/third'), false);

	const thirdResponse = onceValue(third, 'response');
	streams.get('/second')!.end();
	await withTimeout(thirdResponse, 'The third request did not start after a slot became available');
	assert.strictEqual(agent.queue.length, 0);
	assert.strictEqual(agent.sessionCount, 1);
	streams.get('/third')!.end();
});

const waitForCondition = async (predicate: () => boolean, message: string): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		let attempt = 0;
		const interval = setInterval(() => {
			attempt++;
			if (predicate()) {
				clearInterval(interval);
				resolve();
				return;
			}

			if (attempt === 100) {
				clearInterval(interval);
				reject(new Error(message));
			}
		}, 1);
		if (predicate()) {
			clearInterval(interval);
			resolve();
		}
	});
};

// A watchdog, not a budget. Everything it guards settles in tens of milliseconds against a local
// server, so it is set well clear of any plausible delay and only exists to turn a hang into this
// message rather than AVA's generic timeout.
const withTimeout = async <T>(promise: Promise<T>, message: string, watchdog = 5000): Promise<T> => {
	let timeoutId: NodeJS.Timeout | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(message));
				}, watchdog);
			}),
		]);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
};

const waitForSocketClose = async (socket: net.Socket, milliseconds = 500): Promise<boolean> => {
	const socketClosePromise = new Promise<true>(resolve => {
		socket.once('close', () => {
			resolve(true);
		});
	});
	const socketCloseTimeout = new Promise<false>(resolve => {
		const timeout = setTimeout(() => {
			resolve(false);
		}, milliseconds);
		timeout.unref();
	});

	return Promise.race([
		socketClosePromise,
		socketCloseTimeout,
	]);
};

const listenOnIpv6Loopback = async (server: net.Server, port = 0): Promise<number | undefined> => {
	try {
		return await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '::1', () => {
				server.off('error', reject);
				resolve((server.address() as net.AddressInfo).port);
			});
		});
	} catch (error: unknown) {
		if (isIpv6UnavailableError(error)) {
			return undefined;
		}

		throw error;
	}
};

test('https request without ca', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	assert.ok((await got({
		https: {
			certificateAuthority: [],
			rejectUnauthorized: false,
		},
	})).body);
});

test('https request with ca', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({});

	assert.strictEqual(body, 'ok');
});

test('https request with ca and afterResponse hook', withHttpsServer(), async (_t, server, got) => {
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
			assert.fail('unexpected deprecation warning');
		} else {
			// Only the first response is the redirect under test.
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

	assert.strictEqual(body, 'ok');
});

test('https request with `checkServerIdentity` OK', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({
		https: {
			checkServerIdentity(hostname: string, certificate: DetailedPeerCertificate) {
				assert.strictEqual(hostname, 'localhost');
				assert.strictEqual(certificate.subject.CN, 'localhost');
				assert.strictEqual(certificate.issuer.CN, 'authority');
			},
		},
	});

	assert.strictEqual(body, 'ok');
});

test('https request with `checkServerIdentity` NOT OK', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const promise = got({
		https: {
			checkServerIdentity(hostname: string, certificate: DetailedPeerCertificate) {
				assert.strictEqual(hostname, 'localhost');
				assert.strictEqual(certificate.subject.CN, 'localhost');
				assert.strictEqual(certificate.issuer.CN, 'authority');

				return new Error('CUSTOM_ERROR');
			},
		},
	});
	await assert.rejects(
		promise,
		{
			message: 'CUSTOM_ERROR',
		},
	);
});

test('https request with `serverName` option', withHttpsServer(), async (_t, server, got) => {
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

	assert.strictEqual(servername, 'custom.example.com');
});

// The built-in `openssl` on macOS does not support negative days.
{
	const testFunction = process.platform === 'darwin' ? test.skip : test;
	testFunction('https request with expired certificate', withHttpsServer({days: -1}), async (_t, _server, got) => {
		await assert.rejects(
			got({}),
			{
				code: 'CERT_HAS_EXPIRED',
			},
		);
	});
}

test('https request with wrong host', withHttpsServer({commonName: 'not-localhost.com'}), async (_t, _server, got) => {
	await assert.rejects(
		got({}),
		{
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
		},
	);
});

test('http2 uses HTTP/2 when ALPN selects h2', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

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

		assert.strictEqual(response.body, 'ok');
		assert.strictEqual(response.headers['x-protocol'], 'h2');
		assert.strictEqual(Object.hasOwn(response.headers, ':status'), false);
		assert.strictEqual(response.rawHeaders.includes(':status'), false);
	} finally {
		await server.close();
	}
});

test('http2 sends RFC 9113 request pseudo-headers', async _t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({

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
		assert.partialDeepStrictEqual(body, {
			authority: `localhost:${port}`,
			method: 'GET',
			path: '/path?query=value',
			scheme: 'https',
		});
		assert.strictEqual(Object.hasOwn(body, 'host'), false);

		const bodyWithCustomHost = await got(`${server.url}/path`, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				host: 'custom.example',
			},
		}).json<Record<string, string>>();

		assert.partialDeepStrictEqual(bodyWithCustomHost, {
			authority: 'custom.example',
			path: '/path',
		});
		assert.strictEqual(Object.hasOwn(bodyWithCustomHost, 'host'), false);
	} finally {
		await server.close();
	}
});

test('http2 strips HTTP/1.x connection-specific request headers', async _t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({

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

		assert.strictEqual(Object.hasOwn(headers, 'connection'), false);
		assert.strictEqual(Object.hasOwn(headers, 'http2-settings'), false);
		assert.strictEqual(Object.hasOwn(headers, 'keep-alive'), false);
		assert.strictEqual(Object.hasOwn(headers, 'proxy-connection'), false);
		assert.strictEqual(Object.hasOwn(headers, 'transfer-encoding'), false);
		assert.strictEqual(Object.hasOwn(headers, 'upgrade'), false);
		assert.strictEqual(Object.hasOwn(headers, 'x-connection-test'), false);
		assert.strictEqual(headers.te, 'trailers');

		const headersWithInvalidTe = await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			headers: {
				te: 'gzip',
			},
		}).json<Record<string, string>>();

		assert.strictEqual(Object.hasOwn(headersWithInvalidTe, 'te'), false);

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
		assert.strictEqual(headersWithConnectionListedHost[':authority'], `localhost:${port}`);
		assert.strictEqual(Object.hasOwn(headersWithConnectionListedHost, 'host'), false);
	} finally {
		await server.close();
	}
});

test('http2 falls back to HTTP/1.1 when ALPN does not select h2', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.httpVersion);
	});

	const {body} = await got({
		http2: true,
	});

	assert.strictEqual(body, '1.1');
});

test('http2 fallback HTTPS request only advertises HTTP/1.1', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const fallbackProtocols: string[][] = [];
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		allowHTTP1: true,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNCallback({protocols}) {
			fallbackProtocols.push([...protocols]);
			return 'http/1.1';
		},
	}, (request, response) => {
		response.end(request.httpVersion);
	});
	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	try {
		const {port} = server.address() as net.AddressInfo;
		const {body} = await got(`https://localhost:${port}`, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		});

		assert.strictEqual(body, '1.1');
		assert.deepStrictEqual(fallbackProtocols, [
			['h2', 'http/1.1'],
			['http/1.1'],
		]);
	} finally {
		await closeServer(server);
	}
});

test('http2 responses are cached', async _t => {
	let streamCount = 0;
	const server = await createHttp2TestServer(stream => {
		streamCount++;
		stream.respond({

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

		assert.strictEqual(firstResponse.body, '1');
		assert.strictEqual(secondResponse.body, '1');
		assert.strictEqual(firstResponse.isFromCache, false);
		assert.strictEqual(secondResponse.isFromCache, true);
		assert.strictEqual(streamCount, 1);
	} finally {
		await server.close();
	}
});

test('http2 supports GET body when allowGetBody is true', async _t => {
	const server = await createHttp2TestServer(stream => {
		let body = '';
		stream.setEncoding('utf8');
		stream.on('data', chunk => {
			body += String(chunk);
		});
		stream.on('end', () => {
			stream.respond({

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

		assert.strictEqual(body, 'hello');
	} finally {
		await server.close();
	}
});

test('http2 retires sessions after GOAWAY', async _t => {
	let streamCount = 0;
	let firstSession: NonNullable<ServerHttp2Stream['session']> | undefined;
	let secondSession: NonNullable<ServerHttp2Stream['session']> | undefined;
	let firstSessionClose: Promise<unknown> | undefined;
	const server = await createHttp2TestServer(stream => {
		streamCount++;
		stream.respond({

			':status': 200,
		});
		stream.end(String(streamCount));
		if (streamCount === 1) {
			firstSession = stream.session!;
			firstSessionClose = once(firstSession, 'close');
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

		assert.strictEqual((await got(server.url, options)).body, '1');
		await firstSessionClose;
		assert.strictEqual((await got(server.url, options)).body, '2');
		assert.notStrictEqual(firstSession, secondSession);
	} finally {
		await server.close();
	}
});

test('http2 sends request trailers', async _t => {
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

		assert.strictEqual(receivedTrailers?.['x-checksum'], 'abc');
	} finally {
		await server.close();
	}
});

test('http2 normalizes request trailers', async _t => {
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
				'X-Checksum': 'abc',
				connection: 'x-drop',
				'X-Drop': 'bad',
				te: 'gzip',
				'keep-alive': 'timeout=5',
			});
			startBody();
		});

		assert.strictEqual(receivedTrailers?.['x-checksum'], 'abc');
		assert.strictEqual(Object.hasOwn(receivedTrailers ?? {}, 'x-drop'), false);
		assert.strictEqual(Object.hasOwn(receivedTrailers ?? {}, 'te'), false);
		assert.strictEqual(Object.hasOwn(receivedTrailers ?? {}, 'keep-alive'), false);
	} finally {
		await server.close();
	}
});

test('http2 request emits `close` after an error that happens before a stream is created', async _t => {
	const server = net.createServer();
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const {port} = server.address() as net.AddressInfo;
	await closeServer(server);

	const request = http2Request(`https://127.0.0.1:${port}`);
	const events: string[] = [];
	request.once('error', () => {
		events.push('error');
	});
	request.once('close', () => {
		events.push('close');
	});
	request.end();
	await closed(request);
	assert.deepStrictEqual(events, ['error', 'close']);
});

test('http2 request validates undefined header values', _t => {
	assert.throws(() => {
		http2Request('https://example.com', {
			headers: {
				'x-test': undefined,
			},
		});
	}, {
		code: 'ERR_HTTP_INVALID_HEADER_VALUE',
	});

	const request = http2Request('https://example.com');
	assert.throws(() => {
		(request as unknown as {setHeader: (name: string, value: string | string[] | number | undefined) => void}).setHeader('x-test', undefined);
	}, {
		code: 'ERR_HTTP_INVALID_HEADER_VALUE',
	});
	request.destroy();
});

test('http2 request validates trailers', _t => {
	const request = http2Request('https://example.com');
	const pseudoHeaderName = ':path';

	assert.throws(() => {
		request.addTrailers({
			'x-checksum': undefined,
		});
	}, {
		code: 'ERR_HTTP_INVALID_HEADER_VALUE',
	});

	assert.throws(() => {
		request.addTrailers({
			[pseudoHeaderName]: '/',
		});
	}, {
		code: 'ERR_INVALID_HTTP_TOKEN',
	});

	request.destroy();
});

test('http2 request rejects trailers added after stream creation', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.on('end', () => {
			stream.respond({

				':status': 200,
			});
			stream.end('ok');
		});
		stream.resume();
	});

	try {
		const request = http2Request(server.url, {
			method: 'POST',
			rejectUnauthorized: false,
		});
		const responsePromise = onceValue<IncomingMessage>(request, 'response');
		request.write('hello');
		await once(request, 'socket');

		assert.throws(() => {
			request.addTrailers({
				'x-checksum': 'abc',
			});
		}, {
			message: 'Cannot add trailers after the HTTP/2 stream has been created',
		});

		request.end();
		const response = await responsePromise;
		response.resume();
		await once(response, 'end');
	} finally {
		await server.close();
	}
});

test('http2 request rejects trailers added after flush starts', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const request = http2Request(server.url, {
			method: 'POST',
			rejectUnauthorized: false,
		});
		request.on('error', () => {});
		const flushPromise = (request as unknown as {flushHeaders(): Promise<void>}).flushHeaders();

		assert.throws(() => {
			request.addTrailers({
				'x-checksum': 'abc',
			});
		}, {
			message: 'Cannot add trailers after the HTTP/2 stream has been created',
		});

		request.destroy();
		try {
			await flushPromise;
		} catch {}
	} finally {
		await server.close();
	}
});

test('http2 exposes distinct response header values', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: 200,
			'x-values': ['first, second', 'third'],
			'x-single': 'value',
		});
		stream.end('body');
	});
	t.after(server.close);
	const response = await got(server.url, {http2: true, agent: {http2: false}, https: {rejectUnauthorized: false}});

	assert.deepStrictEqual(response.headersDistinct['x-values'], ['first, second', 'third']);
	assert.deepStrictEqual(response.headersDistinct['x-single'], ['value']);
	assert.strictEqual(Object.hasOwn(response.headersDistinct, ':status'), false);
	assert.deepStrictEqual(response.trailersDistinct, {});
});

test('http2 preserves distinct header and trailer values through decompression', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: 200,
			'content-encoding': 'gzip',
			'x-values': ['first, second', 'third'],
		}, {waitForTrailers: true});
		stream.once('wantTrailers', () => {
			stream.sendTrailers({'x-values': ['trailer, one', 'trailer two']});
		});
		stream.end(gzipSync('body'));
	});
	t.after(server.close);
	const response = await got(server.url, {http2: true, agent: {http2: false}, https: {rejectUnauthorized: false}});

	assert.strictEqual(response.body, 'body');
	assert.deepStrictEqual(response.headersDistinct['x-values'], ['first, second', 'third']);
	assert.deepStrictEqual(response.trailersDistinct['x-values'], ['trailer, one', 'trailer two']);
	assert.strictEqual(Object.hasOwn(response.trailersDistinct, ':status'), false);
});

test('http2 exposes response trailers', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

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

		assert.strictEqual(response.body, 'ok');
		assert.strictEqual(response.trailers['x-checksum'], 'abc');
		assert.deepStrictEqual(response.rawTrailers, ['x-checksum', 'abc']);
		assert.deepStrictEqual(response.trailersDistinct['x-checksum'], ['abc']);
	} finally {
		await server.close();
	}
});

test('http2 emits informational and continue events', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.additionalHeaders({

			':status': 100,
		});
		stream.additionalHeaders({

			':status': 102,
			'x-info': 'processing',
		});
		stream.additionalHeaders({

			':status': 103,
			link: [
				'</style.css>; rel=preload',
				'</script.js>; rel=preload',
			],
		});
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	try {
		let continueEmitted = false;
		const informationalResponses: Array<{
			statusCode: number;
			statusMessage: string;
			httpVersion: string;
			httpVersionMajor: number;
			httpVersionMinor: number;
			headers: Record<string, string | string[] | undefined>;
			rawHeaders: string[];
		}> = [];
		const stream = got.stream(server.url, {
			body: 'body',
			headers: {
				expect: '100-continue',
			},
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			method: 'POST',
		});
		stream.once('continue', () => {
			continueEmitted = true;
		});
		stream.on('information', information => {
			informationalResponses.push(information);
		});
		stream.resume();
		await once(stream, 'end');

		assert.strictEqual(continueEmitted, true);
		assert.deepStrictEqual(informationalResponses.map(({statusCode}) => statusCode), [100, 102, 103]);
		assert.partialDeepStrictEqual(informationalResponses[1], {
			statusMessage: '',
			httpVersion: '2.0',
			httpVersionMajor: 2,
			httpVersionMinor: 0,
			headers: {
				'x-info': 'processing',
			},
		});
		assert.deepStrictEqual(informationalResponses[1]!.rawHeaders, ['x-info', 'processing']);
		assert.partialDeepStrictEqual(informationalResponses[2], {
			headers: {
				link: '</style.css>; rel=preload, </script.js>; rel=preload',
			},
		});
		assert.deepStrictEqual(informationalResponses[2]!.rawHeaders, [
			'link',
			'</style.css>; rel=preload',
			'link',
			'</script.js>; rel=preload',
		]);
	} finally {
		await server.close();
	}
});

test('http2 supports abort signals', async _t => {
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
		await assert.rejects(promise, {
			code: 'ERR_ABORTED',
		});
	} finally {
		await server.close();
	}
});

test('http2 abort closes in-flight ALPN probe', async _t => {
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
		const socketPromise = once(server, 'connection');
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
				assert.fail('Expected request to abort');
			} catch (error: unknown) {
				return error as NodeJS.ErrnoException;
			}

			throw new Error('Expected request to abort');
		})();
		await socketPromise;
		const closePromise = once(clientSocket!, 'close');

		controller.abort();

		const error = await rejectionPromise;
		assert.strictEqual(error.code, 'ERR_ABORTED');
		await closePromise;
		assert.strictEqual(clientSocket!.destroyed, true);
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

test('http2 agent clears pending session state when createConnection throws', async _t => {
	const expectedError = new Error('createConnection failed');
	const agent = new Http2Agent();
	const agentState = agent as unknown as {
		sessionCount: number;
		pendingSessionKeys: Set<string>;
		queue: unknown[];
	};
	const options: Parameters<Http2Agent['request']>[1] = {
		createConnection() {
			throw expectedError;
		},
	};
	const rejection = await rejects(agent.request(new URL('https://example.com'), options, {}, {
		endStream: true,
	}));
	assert.strictEqual(rejection, expectedError);

	assert.strictEqual(agentState.sessionCount, 0);
	assert.strictEqual(agentState.pendingSessionKeys.size, 0);
	assert.strictEqual(agentState.queue.length, 0);
});

test('http2 request destroy closes in-flight ALPN probe', async _t => {
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
		const socketPromise = once(server, 'connection');
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
		const requestClosePromise = once(request, 'close');

		request.resume();
		await socketPromise;
		const closePromise = once(clientSocket!, 'close');

		request.destroy();
		await requestClosePromise;
		await closePromise;
		assert.strictEqual(clientSocket!.destroyed, true);
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

test('http2 request destroy cancels in-flight session setup', async _t => {
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
		const secureConnectionPromise = onceValue<tls.TLSSocket>(server, 'secureConnection');
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
		const requestClosePromise = once(request, 'close');

		request.resume();
		const socket = await secureConnectionPromise;
		const socketClosePromise = once(socket, 'close');

		request.destroy();
		await requestClosePromise;
		await socketClosePromise;
		assert.strictEqual(alpnProtocol, 'h2');
		assert.strictEqual(socket.destroyed, true);
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

test('http2 queued session setup cancellation closes ALPN socket', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const sockets = new Set<tls.TLSSocket>();
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
	}, socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
		socket.resume();
	});
	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const agent = new Http2Agent();
	const agentState = agent as unknown as {
		sessionCount: number;
		queue: Array<{options: {_reuseSocket?: tls.TLSSocket}}>;
	};
	type AgentRequestOptions = NonNullable<Parameters<Http2Agent['getSession']>[1]>;

	const ignoreRejection = async (promise: Promise<unknown>): Promise<void> => {
		try {
			await promise;
		} catch {}
	};

	try {
		const {port} = server.address() as net.AddressInfo;
		const url = `https://localhost:${port}`;
		const createSocket = async (): Promise<tls.TLSSocket> => {
			const socket = tls.connect(port, 'localhost', {
				// eslint-disable-next-line @typescript-eslint/naming-convention
				ALPNProtocols: ['h2'],
				rejectUnauthorized: false,
				servername: 'localhost',
			});
			socket.on('error', () => {});
			await once(socket, 'secureConnect');

			return socket;
		};

		const firstSocket = await createSocket();
		const firstOptions: AgentRequestOptions = {
			_reuseSocket: firstSocket,
			_reuseSocketShouldPool: true,
			rejectUnauthorized: false,
		};
		void ignoreRejection(agent.getSession(url, firstOptions));
		await waitForCondition(() => agentState.sessionCount === 1, 'First HTTP/2 session setup did not start');

		const queuedSocket = await createSocket();
		const queuedOptions: AgentRequestOptions = {
			_reuseSocket: queuedSocket,
			_reuseSocketShouldPool: true,
			rejectUnauthorized: false,
		};
		void ignoreRejection(agent.getSession(url, queuedOptions));
		await waitForCondition(
			() => agentState.queue.some(entry => entry.options._reuseSocket === queuedSocket),
			'Second HTTP/2 request did not queue with its ALPN socket',
		);

		queuedOptions._cancelSessionSetup!();

		assert.strictEqual(await waitForSocketClose(queuedSocket), true);
		assert.strictEqual(queuedSocket.destroyed, true);
	} finally {
		agent.destroy();

		for (const socket of sockets) {
			socket.destroy();
		}

		await closeServer(server);
	}
});

test('http2 agent destroy closes in-flight session setup', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const sockets = new Set<tls.TLSSocket>();
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
	}, socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
		socket.resume();
	});
	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const agent = new Http2Agent();
	const agentState = agent as unknown as {sessionCount: number};

	try {
		const {port} = server.address() as net.AddressInfo;
		const url = `https://localhost:${port}`;
		const socket = tls.connect(port, 'localhost', {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			ALPNProtocols: ['h2'],
			rejectUnauthorized: false,
			servername: 'localhost',
		});
		socket.on('error', () => {});
		await once(socket, 'secureConnect');

		const options: NonNullable<Parameters<Http2Agent['getSession']>[1]> = {
			_reuseSocket: socket,
			_reuseSocketShouldPool: true,
			rejectUnauthorized: false,
		};
		const sessionPromise = agent.getSession(url, options);
		await waitForCondition(() => agentState.sessionCount === 1, 'HTTP/2 session setup did not start');

		agent.destroy();

		assert.strictEqual(await waitForSocketClose(socket), true);
		await assert.rejects(sessionPromise, {
			message: 'The HTTP/2 session closed before settings were received',
		});
	} finally {
		agent.destroy();

		for (const socket of sockets) {
			socket.destroy();
		}

		await closeServer(server);
	}
});

test('http2 request fails queued body callbacks when session setup fails', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const sockets = new Set<tls.TLSSocket>();
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
	}, socket => {
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
		const createRequest = () => {
			const request = http2Request(`https://localhost:${port}`, {
				agent: false,
				method: 'POST',
				rejectUnauthorized: false,
				timeout: 50,
			});
			request.on('error', () => {});

			return request;
		};

		const writeRequest = createRequest();
		const writeErrorPromise = new Promise<Error | undefined>(resolve => {
			writeRequest.write('body', error => {
				resolve(error ?? undefined);
			});
		});
		const endOnlyRequest = createRequest();
		const endErrorPromise = new Promise<Error | undefined>(resolve => {
			endOnlyRequest.end((error: Error | undefined) => {
				resolve(error ?? undefined);
			});
		});

		const [writeError, endError] = await withTimeout(
			Promise.all([
				writeErrorPromise,
				endErrorPromise,
			]),
			'Queued HTTP/2 body callbacks were not failed',
		);

		assert.strictEqual(writeError?.name, 'TimeoutError');
		assert.strictEqual(endError?.name, 'TimeoutError');
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}

		await closeServer(server);
	}
});

test('http2 request fails queued body callback when explicit h2session request throws', async _t => {
	const expectedError = new Error('session failed');
	const createRequest = () => {
		const request = http2Request('https://example.com', {
			h2session: {
				request() {
					throw expectedError;
				},
			} as unknown as http2.ClientHttp2Session,
		});
		request.on('error', () => {});

		return request;
	};

	const writeRequest = createRequest();
	const writeErrorPromise = new Promise<Error | undefined>(resolve => {
		writeRequest.write('body', error => {
			resolve(error ?? undefined);
		});
	});
	const endOnlyRequest = createRequest();
	const endErrorPromise = new Promise<Error | undefined>(resolve => {
		endOnlyRequest.end((error: Error | undefined) => {
			resolve(error ?? undefined);
		});
	});
	const [writeError, endError] = await withTimeout(
		Promise.all([
			writeErrorPromise,
			endErrorPromise,
		]),
		'Queued HTTP/2 body callbacks were not failed',
	);

	assert.strictEqual(writeError, expectedError);
	assert.strictEqual(endError, expectedError);
});

test('http2 stream destroy closes queued ALPN socket', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const sockets = new Set<tls.TLSSocket>();
	const secureContext = tls.createSecureContext({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	let sniCallbackCount = 0;
	let firstSniCallback!: Parameters<NonNullable<tls.TlsOptions['SNICallback']>>[1];
	let secondSniCallback!: Parameters<NonNullable<tls.TlsOptions['SNICallback']>>[1];
	let resolveFirstSni!: () => void;
	let resolveSecondSni!: () => void;
	const firstSni = new Promise<void>(resolve => {
		resolveFirstSni = resolve;
	});
	const secondSni = new Promise<void>(resolve => {
		resolveSecondSni = resolve;
	});
	const server = tls.createServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		ALPNProtocols: ['h2'],
		// eslint-disable-next-line @typescript-eslint/naming-convention
		SNICallback(_servername, callback) {
			sniCallbackCount++;
			if (sniCallbackCount === 1) {
				firstSniCallback = callback;
				resolveFirstSni();
				return;
			}

			secondSniCallback = callback;
			resolveSecondSni();
		},
	}, socket => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
		socket.resume();
	});
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	const agent = new Http2Agent();
	const agentState = agent as unknown as {
		sessionCount: number;
		queue: Array<{options: {_reuseSocket?: tls.TLSSocket; _reuseSocketShouldPool?: boolean}}>;
	};
	const requests: Array<ReturnType<typeof got.stream>> = [];

	try {
		const {port} = server.address() as net.AddressInfo;
		const url = `https://localhost:${port}`;
		const dnsLookup = ((_hostname: string, options: any, callback: any) => {
			if (options.all) {
				callback(null, [{address: '127.0.0.1', family: 4}]);
				return;
			}

			callback(null, '127.0.0.1', 4);
		}) as LookupFunction;
		const options = {
			http2: true,
			dnsLookup,
			hooks: {
				beforeRequest: [
					(options: NormalizedOptions) => {
						(options.agent as {http2?: Http2Agent}).http2 = agent;
					},
				],
			},
			retry: {
				limit: 0,
			},
			https: {
				rejectUnauthorized: false,
			},
		};
		const firstRequest = got.stream(url, options);
		requests.push(firstRequest);
		firstRequest.on('error', () => {});
		firstRequest.resume();

		const secondRequest = got.stream(url, options);
		requests.push(secondRequest);
		secondRequest.on('error', () => {});
		secondRequest.resume();
		await firstSni;
		await secondSni;
		firstSniCallback(null, secureContext);
		await waitForCondition(() => agentState.sessionCount === 1, 'First HTTP/2 session setup did not start');
		secondSniCallback(null, secureContext);

		let queuedSocket!: tls.TLSSocket;
		await waitForCondition(
			() => {
				const entry = agentState.queue.find(entry => entry.options._reuseSocketShouldPool === true && entry.options._reuseSocket);
				if (entry?.options._reuseSocket) {
					queuedSocket = entry.options._reuseSocket;
					return true;
				}

				return false;
			},
			'Second HTTP/2 request did not queue with its ALPN socket',
		);

		secondRequest.destroy();

		assert.strictEqual(await waitForSocketClose(queuedSocket), true);
		assert.strictEqual(queuedSocket.destroyed, true);
	} finally {
		for (const request of requests) {
			request.destroy();
		}

		agent.destroy();

		for (const socket of sockets) {
			socket.destroy();
		}

		await closeServer(server);
	}
});

test('http2 supports explicit h2session option', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});
	const session = http2.connect(server.url, {
		rejectUnauthorized: false,
	});

	try {
		await once(session, 'remoteSettings');
		assert.strictEqual(server.sessions.size, 1);

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

		assert.strictEqual(body, 'ok');
		assert.strictEqual(server.sessions.size, 1);
		assert.strictEqual(session.destroyed, false);
	} finally {
		session.destroy();
		await server.close();
	}
});

test('http2 supports h2c with explicit h2session option', async _t => {
	const server = http2.createServer();

	server.on('stream', (stream: ServerHttp2Stream, headers) => {
		stream.respond({

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

		assert.deepStrictEqual(JSON.parse(body) as Record<string, string>, {
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

test('http2 direct request preserves port from host option', async _t => {
	const server = http2.createServer((request, response) => {
		response.end(String(request.headers[':authority']));
	});
	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const {port} = server.address() as net.AddressInfo;
	const session = http2.connect(`http://localhost:${port}`);

	try {
		const body = await collectHttp2ResponseBody(http2Request({
			protocol: 'http:',
			host: `localhost:${port}`,
			path: '/',
			h2session: session,
		}));

		assert.strictEqual(body, `localhost:${port}`);
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

test('http2 CONNECT request sends path as authority', async _t => {
	const server = http2.createServer();

	server.on('stream', (stream: ServerHttp2Stream, headers) => {
		stream.respond({

			':status': 200,
			'content-type': 'application/json',
		});
		stream.end(JSON.stringify({
			authority: headers[':authority'],
			method: headers[':method'],
			path: headers[':path'],
			scheme: headers[':scheme'],
		}));
	});
	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const {port} = server.address() as net.AddressInfo;
	const session = http2.connect(`http://localhost:${port}`);

	try {
		const body = await collectHttp2ResponseBody(http2Request({
			protocol: 'http:',
			hostname: 'localhost',
			port,
			method: 'CONNECT',
			path: 'target.example:443',
			h2session: session,
		}));

		assert.deepStrictEqual(JSON.parse(body) as Record<string, string>, {
			authority: 'target.example:443',
			method: 'CONNECT',
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

test('http2 supports IPv6 h2c URLs with explicit h2session option', async _t => {
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
		if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPERM'].includes(error.code)) {
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

		assert.strictEqual(body, '/h2c-ipv6');
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

test('http2 clears explicit h2session on cross-origin redirects', async _t => {
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

				':status': 302,
				location: `${secondUrl}/target`,
			});
			stream.end();
			return;
		}

		if (headers[':path'] === '/hook-start') {
			stream.respond({

				':status': 302,
				location: `${firstUrl}/same-origin-target`,
			});
			stream.end();
			return;
		}

		stream.respond({

			':status': 200,
		});
		stream.end('wrong-origin');
	});
	secondServer.on('stream', (stream: ServerHttp2Stream) => {
		secondServerRequests++;
		stream.respond({

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

		assert.strictEqual(body, 'ok');

		const hookRedirectResponse = await got(`${firstUrl}/hook-start`, {
			hooks,
		});

		assert.strictEqual(hookRedirectResponse.body, 'ok');
		assert.strictEqual(firstServerRequests, 2);
		assert.strictEqual(secondServerRequests, 2);
	} finally {
		for (const session of sessions.values()) {
			session.destroy();
		}

		await close(firstServer);
		await close(secondServer);
	}
});

test('http2 supports IPv6 HTTPS authorities', async _t => {
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
		if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPERM'].includes(error.code)) {
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

		assert.strictEqual(body, `[::1]:${port}`);
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

test('http2 rejects pseudo-headers in request headers', async _t => {
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

				':path': '/evil',
			},
		});
		await assert.rejects(gotPromise, {
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

// Other concurrent tests can fill the shared agent's idle-session pool.
test.serial('http2 connection reuse with default agent', async _t => {
	const sessions: Array<NonNullable<ServerHttp2Stream['session']>> = [];
	const streamClosedPromises: Array<Promise<unknown>> = [];
	const server = await createHttp2TestServer((stream, headers) => {
		sessions.push(stream.session!);
		streamClosedPromises.push(once(stream, 'close'));
		const isCreatedResponse = headers[':path'] === '/201';
		stream.respond({

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

		assert.strictEqual(response1.statusCode, 200);
		assert.strictEqual(response2.statusCode, 201);
		assert.strictEqual(server.sessions.size, 1);
		assert.strictEqual(sessions[0] === sessions[1], true);
	} finally {
		await server.close();
	}
});

// Other concurrent tests can fill the shared agent's idle-session pool.
test.serial('http2 cold concurrent requests share default agent session', async _t => {
	const sessions: Array<NonNullable<ServerHttp2Stream['session']>> = [];
	const server = await createHttp2TestServer(stream => {
		sessions.push(stream.session!);
		stream.respond({

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

		assert.deepStrictEqual(responses.map(response => response.body), ['ok', 'ok', 'ok', 'ok', 'ok']);
		assert.strictEqual(server.sessions.size, 1);
		assert.strictEqual(sessions.every(session => session === sessions[0]), true);
	} finally {
		await server.close();
	}
});

test('http2 reports reusedSocket for pooled sessions', async _t => {
	const agent = new Http2Agent();
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	try {
		const options = {
			http2: true,
			// Keep concurrent tests from evicting this test's idle session from the global pool.
			request: (url: URL, options: NativeRequestOptions) => http2Request(url, {...options, agent}),
			https: {
				rejectUnauthorized: false,
			},
		};
		const firstResponse = await got(`${server.url}/first`, options);
		const secondResponse = await got(`${server.url}/second`, options);

		assert.strictEqual(firstResponse.request.reusedSocket, false);
		assert.strictEqual(secondResponse.request.reusedSocket, true);
	} finally {
		agent.destroy();
		await server.close();
	}
});

test('http2 session pool distinguishes checkServerIdentity function identity', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<http2.ServerHttp2Session>();

	server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({

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

		assert.strictEqual((await got(url, options)).body, 'ok');
		await assert.rejects(got(url, {
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

test('http2 does not exceed maxConcurrentStreams on pooled sessions', async _t => {
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

		assert.strictEqual(slowResponse.body, 'slow');
		assert.strictEqual(fastResponse.body, 'fast');
		assert.strictEqual(maxActiveStreamsPerSession, 1);
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

test('http2 does not reuse sessions across different checkServerIdentity options', async _t => {
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

		assert.strictEqual((await got(url, {
			http2: true,
			https: {
				certificateAuthority,
				checkServerIdentity() {
					acceptedCheckCount++;
					return undefined;
				},
			},
		})).body, 'ok');
		await assert.rejects(got(url, {
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

		assert.strictEqual(acceptedCheckCount, 1);
		assert.strictEqual(rejectedCheckCount, 1);
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

test('http2 agent false reuses the ALPN socket for the current request', async _t => {
	let secureConnectionCount = 0;
	let sessionClose: Promise<unknown> | undefined;
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	server.server.on('secureConnection', () => {
		secureConnectionCount++;
	});
	server.server.once('session', session => {
		sessionClose = once(session, 'close');
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

		assert.strictEqual(body, 'ok');
		assert.strictEqual(secureConnectionCount, 1);
		await sessionClose;
		assert.strictEqual(server.sessions.size, 0);
	} finally {
		await server.close();
	}
});

test('http2 abort closes only the affected stream', async _t => {
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
		await assert.rejects(slowRequest, {
			code: 'ERR_ABORTED',
		});
		assert.strictEqual((await fastRequest).body, 'ok');
		assert.strictEqual(session.destroyed, false);
	} finally {
		session.destroy();
		await server.close();
	}
});

test('http2 ALPN uses createConnection', async _t => {
	let createConnectionCount = 0;
	const server = await createHttp2TestServer(stream => {
		stream.respond({

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

		assert.strictEqual(body, 'ok');
		assert.strictEqual(createConnectionCount, 1);
	} finally {
		await server.close();
	}
});

test('http2 ALPN createConnection does not reuse pooled session', async _t => {
	const firstServer = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('first');
	});
	let secondSessionClose: Promise<unknown> | undefined;
	const secondServer = await createHttp2TestServer(stream => {
		secondSessionClose = once(stream.session!, 'close');
		stream.respond({

			':status': 200,
		});
		stream.end('second');
	});

	try {
		const firstUrl = firstServer.url;
		const secondPort = new URL(secondServer.url).port;

		assert.strictEqual((await got(firstUrl, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
		})).body, 'first');

		assert.strictEqual((await got(firstUrl, {
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

		assert.strictEqual((await got(firstUrl, {
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

test('http2 rejects when session closes before settings', async _t => {
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
		await assert.rejects(got(`https://127.0.0.1:${port}`, {
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

test('http2 session pool distinguishes lookup function identity', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const createServer = async (host: string, port?: number) => {
		const server = http2.createSecureServer({
			key: certificate.serviceKey,
			cert: certificate.certificate,
		});
		const sessions = new Set<http2.ServerHttp2Session>();

		server.on('stream', (stream: ServerHttp2Stream) => {
			stream.respond({

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
		if (host === '::1') {
			const actualPort = await listenOnIpv6Loopback(server, port);
			return actualPort === undefined ? undefined : {server, sessions};
		}

		await new Promise<void>(resolve => {
			server.listen(port ?? 0, host, resolve);
		});

		return {server, sessions};
	};

	const ipv4Server = await createServer('127.0.0.1');
	if (ipv4Server === undefined) {
		throw new Error('IPv4 loopback is not available');
	}

	const {port} = ipv4Server.server.address() as net.AddressInfo;
	const ipv6Server = await createServer('::1', port);
	if (ipv6Server === undefined) {
		await closeServer(ipv4Server.server);
		return;
	}

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
		assert.strictEqual((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('127.0.0.1', 4),
		})).body, '127.0.0.1');
		assert.strictEqual((await got(url, {
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

		await closeServer(ipv6Server.server);
		await closeServer(ipv4Server.server);
	}
});

test('http2 ALPN ignores cached protocols when using createConnection', async _t => {
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

		assert.strictEqual((await got(url, options)).body, 'http1');
		assert.strictEqual((await got(url, {
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

test('http2 ALPN protocol cache distinguishes lookup function identity', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const http2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});

	http2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({

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

	const ipv6Port = await listenOnIpv6Loopback(http1Server, port);
	if (ipv6Port === undefined) {
		await closeServer(http2Server);
		return;
	}

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
		assert.strictEqual((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('127.0.0.1', 4),
		})).body, 'h2');
		assert.strictEqual((await got(url, {
			...baseOptions,
			dnsLookup: createLookup('::1', 6),
		})).body, 'http1');
	} finally {
		await closeServer(http1Server);
		await closeServer(http2Server);
	}
});

test('http2 ALPN protocol cache distinguishes DNS lookup IP family', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const http2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});

	http2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({

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

	const ipv6Port = await listenOnIpv6Loopback(http1Server, port);
	if (ipv6Port === undefined) {
		await closeServer(http2Server);
		return;
	}

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
		assert.strictEqual((await got(url, {
			...baseOptions,
			dnsLookupIpVersion: 4 as const,
		})).body, 'h2');
		assert.strictEqual((await got(url, {
			...baseOptions,
			dnsLookupIpVersion: 6 as const,
		})).body, 'http1');
	} finally {
		await closeServer(http1Server);
		await closeServer(http2Server);
	}
});

test('http2 ALPN protocol cache preserves protocol order', async _t => {
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

		assert.strictEqual((await got(url, {
			...baseOptions,
			https: {
				...baseOptions.https,
				alpnProtocols: ['h2', 'http/1.1'],
			},
		})).body, '2.0');
		assert.strictEqual((await got(url, {
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

test('http2 ALPN protocol cache evicts old origins', async _t => {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const h2Server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});

	h2Server.on('stream', (stream: ServerHttp2Stream) => {
		stream.respond({

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
		assert.strictEqual((await got(`https://cache-${index}.invalid:${port}`, options)).body, 'h2');
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
		assert.strictEqual((await got(`https://cache-0.invalid:${port}`, options)).body, 'http1');
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

test('http2 ALPN uses the default HTTPS port', async _t => {
	let createConnectionCount = 0;
	let observedPort: string | number | undefined;
	const server = await createHttp2TestServer(stream => {
		stream.respond({

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

		assert.strictEqual(body, 'ok');
		assert.strictEqual(createConnectionCount, 1);
		assert.strictEqual(observedPort, 443);
	} finally {
		await server.close();
	}
});

test('http2 ALPN still runs when HTTPS agent is false', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

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

		assert.strictEqual(body, 'ok');
	} finally {
		await server.close();
	}
});

test('http2 uses native HTTP/1.1 path with custom HTTPS agent', withHttpsServer(), async (_t, server, got) => {
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

		assert.strictEqual(body, '1.1');
		assert.strictEqual(secureConnectionCount, 1);
	} finally {
		agent.destroy();
	}
});

test('http2 custom request receives native HTTPS agent option', withHttpsServer(), async (_t, server, got) => {
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

		assert.strictEqual(body, 'ok');
		assert.strictEqual(receivedAgent, agent);
	} finally {
		agent.destroy();
	}
});

test('http2 custom HTTPS agent only advertises HTTP/1.1', async _t => {
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

		assert.strictEqual(body, '1.1');
		assert.strictEqual(sawHttp2Stream, false);
		assert.strictEqual(alpnProtocol, 'http/1.1');
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

test.serial('deprecated `rejectUnauthorized` option', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	await assert.rejects(got({
		// @ts-expect-error Testing purposes
		rejectUnauthorized: false,
	}), {
		message: 'Unexpected option: rejectUnauthorized',
	});
});

test.serial('non-deprecated `rejectUnauthorized` option', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	(async () => {
		const warning = await onceValue<Error>(process, 'warning');
		assert.notStrictEqual(warning.name, 'DeprecationWarning');
	})();

	await got({
		https: {
			rejectUnauthorized: false,
		},
	});
});

test('client certificate', withHttpsServer(), async (_t, server, got) => {
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

	assert.strictEqual(response.authorized, true);
	assert.strictEqual(response.peerCertificate.subject.CN, 'client');
	assert.strictEqual(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid client certificate (self-signed)', withHttpsServer(), async (_t, server, got) => {
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

	assert.strictEqual(response.authorized, false);
});

test('invalid client certificate (other CA)', withHttpsServer(), async (_t, server, got) => {
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

	assert.strictEqual(response.authorized, false);
	assert.strictEqual(response.peerCertificate.subject.CN, 'other-client');
	assert.strictEqual(response.peerCertificate.issuer.CN, 'other-authority');
});

test('key passphrase', withHttpsServer(), async (_t, server, got) => {
	// Ignore macOS for now as it fails with some internal OpenSSL error.
	if (process.platform === 'darwin') {
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

	assert.strictEqual(response.authorized, true);
	assert.strictEqual(response.peerCertificate.subject.CN, 'client');
	assert.strictEqual(response.peerCertificate.issuer.CN, 'authority');
});

test('invalid key passphrase', withHttpsServer(), async (_t, server, got) => {
	// Ignore macOS for now as it fails with some internal OpenSSL error.
	if (process.platform === 'darwin') {
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

	const {code}: NodeJS.ErrnoException = (await rejects(request));
	assert.strictEqual(code === 'ERR_OSSL_BAD_DECRYPT' || code === 'ERR_OSSL_EVP_BAD_DECRYPT', true, `Unexpected code ${code}`);
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

test('https request with `ciphers` option', withHttpsServer({ciphers: stableCiphers.join(':'), minVersion: 'TLSv1.3'}), async (_t, server, got) => {
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

	assert.strictEqual(response.cipher, stableCiphers[0]!);
});

test('https request with `honorCipherOrder` option', withHttpsServer({ciphers: `${stableCiphers[0]!}:${stableCiphers[1]!}`, minVersion: 'TLSv1.3'}), async (_t, server, got) => {
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

	assert.strictEqual(response.cipher, stableCiphers[0]!);
});

test('https request with `minVersion` option', withHttpsServer({maxVersion: 'TLSv1.2'}), async (_t, server, got) => {
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
	await assert.rejects(request, {
		code: 'EPROTO',
	});
});

test('http2 request timeouts notify both the callback and timeout listeners', async _t => {
	const server = await createHttp2TestServer(() => {});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	request.on('error', () => {});
	let timeoutEvents = 0;
	request.on('timeout', () => {
		timeoutEvents++;
	});

	try {
		const timeout = new Promise<void>(resolve => {
			request.setTimeout(20, resolve);
		});
		request.end();
		await withTimeout(timeout, 'HTTP/2 request timeout callback did not run');
		assert.strictEqual(timeoutEvents, 1);
	} finally {
		request.destroy();
		await server.close();
	}
});

for (const afterSocket of [false, true]) {
	test(`http2 timeout callbacks can be removed when configured afterSocket ${afterSocket}`, async _t => {
		const server = await createHttp2TestServer(() => {});
		const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
		request.on('error', () => {});
		let removedCallbackCalls = 0;
		const removedCallback = () => {
			removedCallbackCalls++;
		};

		try {
			if (afterSocket) {
				const socket = once(request, 'socket');
				request.end();
				await socket;
			}

			const timeout = new Promise<void>(resolve => {
				assert.strictEqual(request.setTimeout(20, removedCallback), request);
				request.removeListener('timeout', removedCallback);
				request.setTimeout(20, function (this: ReturnType<typeof http2Request>) {
					assert.strictEqual(this, request);
					resolve();
				});
			});
			if (!afterSocket) {
				request.end();
			}

			await withTimeout(timeout, 'HTTP/2 request timeout did not run');
			assert.strictEqual(removedCallbackCalls, 0);
		} finally {
			request.destroy();
			await server.close();
		}
	});
}

test('http2 request timeout listeners can cancel a Got request', async _t => {
	const server = await createHttp2TestServer(() => {});
	const expectedError = new Error('idle request');

	try {
		const promise = got(server.url, {
			http2: true,
			https: {rejectUnauthorized: false},
			retry: {limit: 0},
		}).on('request', request => {
			request.setTimeout(20);
			request.once('timeout', () => {
				request.destroy(expectedError);
			});
		});

		const error = await rejects(withTimeout(promise, 'Got did not emit its native request timeout'), {message: 'idle request'});
		assert.strictEqual(error.cause, expectedError);
	} finally {
		await server.close();
	}
});

test('http2 response timeouts notify response listeners and honor callback removal', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond();
		stream.write('partial');
	});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	request.on('error', () => {});
	let removedCallbackCalls = 0;

	try {
		const responsePromise = onceValue<IncomingMessage>(request, 'response');
		request.end();
		const response = await responsePromise;
		const removedCallback = () => {
			removedCallbackCalls++;
		};

		let timeoutEvents = 0;

		response.on('timeout', () => {
			timeoutEvents++;
		});
		const timeout = new Promise<void>(resolve => {
			assert.strictEqual(response.setTimeout(20, removedCallback), response);
			response.removeListener('timeout', removedCallback);
			response.setTimeout(20, function (this: IncomingMessage) {
				assert.strictEqual(this, response);
				resolve();
			});
		});
		await withTimeout(timeout, 'HTTP/2 response timeout did not run');
		assert.strictEqual(timeoutEvents, 1);
		assert.strictEqual(removedCallbackCalls, 0);
	} finally {
		request.destroy();
		await server.close();
	}
});

test('http2 response timeout callbacks run once', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond();
		stream.write('partial');
	});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	request.on('error', () => {});

	try {
		const responsePromise = onceValue<IncomingMessage>(request, 'response');
		request.end();
		const response = await responsePromise;

		let calls = 0;
		const timeout = new Promise<void>(resolve => {
			response.setTimeout(20, () => {
				calls++;
				resolve();
			});
		});
		assert.strictEqual(response.listenerCount('timeout'), 1);
		await withTimeout(timeout, 'HTTP/2 response timeout did not run');
		assert.strictEqual(response.listenerCount('timeout'), 0);

		// Registering another timeout must not replay the callback of the previous one.
		const second = new Promise<void>(resolve => {
			response.setTimeout(20, resolve);
		});
		await withTimeout(second, 'HTTP/2 second response timeout did not run');
		assert.strictEqual(calls, 1);
	} finally {
		request.destroy();
		await server.close();
	}
});

test('http2 request timeouts can be disabled before the stream is assigned', async _t => {
	const server = await createHttp2TestServer(stream => {
		const timer = setTimeout(() => {
			stream.respond();
			stream.end('success');
		}, 60);
		stream.once('close', () => {
			clearTimeout(timer);
		});
	});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	let timeoutEvents = 0;
	request.setTimeout(10, () => {
		timeoutEvents++;
	});
	request.setTimeout(0);

	try {
		assert.strictEqual(await collectHttp2ResponseBody(request), 'success');
		assert.strictEqual(timeoutEvents, 0);
	} finally {
		request.destroy();
		await server.close();
	}
});

test('http2 response emits explicit destruction errors', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond();
		stream.write('partial');
	});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	request.on('error', () => {});

	try {
		const responsePromise = onceValue<IncomingMessage>(request, 'response');
		request.end();
		const response = await responsePromise;
		const errors: Error[] = [];
		response.on('error', error => {
			errors.push(error);
		});
		const close = closed(response);
		const expectedError = new Error('consumer failure');
		response.destroy(expectedError);
		response.destroy(new Error('ignored repeated destruction'));
		await close;
		assert.deepStrictEqual(errors, [expectedError]);
	} finally {
		request.destroy();
		await server.close();
	}
});

test('http2 response destruction errors propagate through Got streams', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond();
		stream.write('partial');
	});
	const expectedError = new Error('consumer failure');

	try {
		const request = got.stream(server.url, {
			http2: true,
			https: {rejectUnauthorized: false},
			retry: {limit: 0},
		}).on('response', response => {
			response.destroy(expectedError);
		});
		const error = await rejects(request.toArray(), {message: 'consumer failure'});

		assert.strictEqual(error.cause, expectedError);
	} finally {
		await server.close();
	}
});

test('http2 response destruction without an error closes quietly', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond();
		stream.write('partial');
	});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	request.on('error', () => {});

	try {
		const responsePromise = onceValue<IncomingMessage>(request, 'response');
		request.end();
		const response = await responsePromise;
		const errors: Error[] = [];
		response.on('error', error => {
			errors.push(error);
		});
		const close = once(response, 'close');
		response.destroy();
		await close;

		assert.deepStrictEqual(errors, []);
		assert.strictEqual(response.destroyed, true);
		assert.strictEqual(response.readableAborted, true);
	} finally {
		request.destroy();
		await server.close();
	}
});

test('http2 response completion does not create a destruction error', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond();
		stream.end('complete');
	});
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	const responsePromise = onceValue<IncomingMessage>(request, 'response');

	try {
		const body = collectHttp2ResponseBody(request);
		const response = await responsePromise;
		const close = once(response, 'close');
		assert.strictEqual(await body, 'complete');
		await close;

		assert.strictEqual(response.complete, true);
		assert.strictEqual(response.readableAborted, false);
		assert.strictEqual(response.errored, null);
	} finally {
		request.destroy();
		await server.close();
	}
});

// RFC 9113 section 8.1 permits repeated interim responses before exactly one final response.
test('http2 protocol preserves repeated early hints until the final response', async t => {
	let serverStream: ServerHttp2Stream;
	const server = await createHttp2TestServer(stream => {
		serverStream = stream;
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 103, link: '</first.css>; rel=preload'});
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 103, link: '</second.css>; rel=preload'});
	});
	t.after(server.close);
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	const links: string[] = [];
	const events: string[] = [];
	request.on('information', information => {
		events.push('information');
		links.push(information.headers.link as string);
		assert.strictEqual(Object.hasOwn(information.headers, ':status'), false);
		if (links.length === 2) {
			assert.deepStrictEqual(events, ['information', 'information']);
			serverStream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200, 'x-final': 'yes'});
			serverStream.end('final body');
		}
	});
	request.on('response', response => {
		events.push('response');
		assert.strictEqual(response.headers['x-final'], 'yes');
		assert.strictEqual(Object.hasOwn(response.headers, 'link'), false);
	});
	assert.strictEqual(await collectHttp2ResponseBody(request), 'final body');
	assert.deepStrictEqual(links, ['</first.css>; rel=preload', '</second.css>; rel=preload']);
	assert.deepStrictEqual(events, ['information', 'information', 'response']);
});

test('http2 protocol accepts unsolicited continue without replacing the final response', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 100});
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 201});
		stream.end('created');
	});
	t.after(server.close);
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	let continueCount = 0;
	const statuses: number[] = [];
	request.on('continue', () => {
		continueCount++;
	});
	request.on('information', information => {
		statuses.push(information.statusCode);
	});
	request.once('response', response => {
		assert.strictEqual(response.statusCode, 201);
	});
	assert.strictEqual(await collectHttp2ResponseBody(request), 'created');
	assert.strictEqual(continueCount, 1);
	assert.deepStrictEqual(statuses, [100]);
});

test('http2 protocol preserves a final error response after processing information', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 102, 'x-progress': 'working'});
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 422, 'content-type': 'application/json'});
		stream.end('{"error":"invalid input"}');
	});
	t.after(server.close);
	const statuses: number[] = [];
	const response = await got(server.url, {
		http2: true, agent: {http2: false}, https: {rejectUnauthorized: false}, throwHttpErrors: false, responseType: 'json',
	}).on('request', request => {
		request.on('information', information => {
			statuses.push(information.statusCode);
		});
	});
	assert.deepStrictEqual(statuses, [102]);
	assert.strictEqual(response.statusCode, 422);
	assert.deepStrictEqual(response.body, {error: 'invalid input'});
});

test('http2 protocol ignores unobserved interim responses before a normal final body', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 103, link: '</style.css>; rel=preload'});
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end('body');
	});
	t.after(server.close);
	assert.strictEqual(await got(server.url, {http2: true, agent: {http2: false}, https: {rejectUnauthorized: false}}).text(), 'body');
});

// Content-Length on HEAD and 304 describes the selected representation, not an expected response body (RFC 9110 section 8.6).
for (const method of ['HEAD', 'GET'] as const) {
	test(`http2 protocol preserves representation metadata for ${method === 'HEAD' ? 'HEAD' : '304'}`, async t => {
		const statusCode = method === 'HEAD' ? 200 : 304;
		const server = await createHttp2TestServer((stream, headers) => {
			assert.strictEqual(headers[':method'], method);
			stream.respond({
				[http2.constants.HTTP2_HEADER_STATUS]: statusCode,
				'content-length': 1234,
				'content-encoding': 'gzip',
				etag: '"version-1"',
			}, {endStream: true});
		});
		t.after(server.close);
		const response = await got(server.url, {
			method, http2: true, agent: {http2: false}, https: {rejectUnauthorized: false},
			headers: method === 'GET' ? {'if-none-match': '"version-1"'} : {},
		});
		assert.strictEqual(response.statusCode, statusCode);
		assert.strictEqual(response.body, '');
		assert.strictEqual(response.headers['content-length'], '1234');
		assert.strictEqual(response.headers['content-encoding'], 'gzip');
		assert.strictEqual(response.headers.etag, '"version-1"');
		assert.strictEqual(response.complete, true);
	});
}

test('http2 protocol completes a 204 final response after early hints', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 103, link: '</style.css>; rel=preload'});
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 204, etag: '"updated"'}, {endStream: true});
	});
	t.after(server.close);
	const statuses: number[] = [];
	const response = await got(server.url, {http2: true, agent: {http2: false}, https: {rejectUnauthorized: false}}).on('request', request => {
		request.on('information', information => {
			statuses.push(information.statusCode);
		});
	});
	assert.deepStrictEqual(statuses, [103]);
	assert.strictEqual(response.statusCode, 204);
	assert.strictEqual(response.body, '');
	assert.strictEqual(response.headers.etag, '"updated"');
	assert.strictEqual(Object.hasOwn(response.headers, 'content-length'), false);
	assert.strictEqual(response.complete, true);
});

test('http2 protocol completes an empty 200 response at the final headers', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200, 'content-length': 0}, {endStream: true});
	});
	t.after(server.close);
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	let response: IncomingMessage | undefined;
	request.once('response', incoming => {
		response = incoming;
	});
	assert.strictEqual(await collectHttp2ResponseBody(request), '');
	assert.strictEqual(response!.complete, true);
	assert.deepStrictEqual(response!.trailers, {});
	assert.deepStrictEqual(response!.rawTrailers, []);
});

for (const body of ['', 'payload']) {
	test(`http2 protocol completes ${body === '' ? 'empty' : 'nonempty'} content with an empty trailer section`, async t => {
		const server = await createHttp2TestServer(stream => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200}, {waitForTrailers: true});
			stream.once('wantTrailers', () => {
				stream.sendTrailers({});
			});
			stream.end(body);
		});
		t.after(server.close);
		const response = await got(server.url, {http2: true, agent: {http2: false}, https: {rejectUnauthorized: false}});
		assert.strictEqual(response.body, body);
		assert.strictEqual(response.complete, true);
		assert.deepStrictEqual(response.rawTrailers, []);
		assert.deepStrictEqual({...response.trailersDistinct}, {});
	});
}

test('http2 protocol keeps final headers and trailers separate after interim headers', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.additionalHeaders({[http2.constants.HTTP2_HEADER_STATUS]: 103, 'x-values': 'interim'});
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200, 'x-values': 'final'}, {waitForTrailers: true});
		stream.once('wantTrailers', () => {
			stream.sendTrailers({'x-values': ['trailer, one', 'trailer two']});
		});
		stream.end('body');
	});
	t.after(server.close);
	const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
	const informationValues: string[] = [];
	let response: IncomingMessage | undefined;
	request.on('information', information => {
		informationValues.push(information.headers['x-values'] as string);
	});
	request.once('response', incoming => {
		response = incoming;
		assert.deepStrictEqual(incoming.rawTrailers, []);
	});
	assert.strictEqual(await collectHttp2ResponseBody(request), 'body');
	assert.deepStrictEqual(informationValues, ['interim']);
	assert.deepStrictEqual(response!.headersDistinct['x-values'], ['final']);
	assert.deepStrictEqual(response!.trailersDistinct['x-values'], ['trailer, one', 'trailer two']);
	assert.deepStrictEqual(response!.rawTrailers, ['x-values', 'trailer, one', 'x-values', 'trailer two']);
	assert.strictEqual(response!.complete, true);
});

test('http2 protocol delivers request trailers even when the upload has no data', async t => {
	const server = await createHttp2TestServer(stream => {
		let dataEvents = 0;
		let checksum: string | string[] | undefined;
		stream.on('data', () => {
			dataEvents++;
		});
		stream.once('trailers', trailers => {
			checksum = trailers['x-checksum'];
		});
		stream.once('end', () => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
			stream.end(JSON.stringify({dataEvents, checksum}));
		});
	});
	t.after(server.close);
	const request = http2Request(server.url, {method: 'POST', agent: false, rejectUnauthorized: false});
	request.addTrailers({'x-checksum': 'empty-content'});
	assert.deepStrictEqual(JSON.parse(await collectHttp2ResponseBody(request)), {dataEvents: 0, checksum: 'empty-content'});
});

// All native header mutation APIs must apply the HTTP/2 field filtering rules in RFC 9113 section 8.2.2.
for (const headerApi of ['Headers', 'Map', 'appendHeader']) {
	test(`http2 protocol filters connection fields through ${headerApi} while retaining TE trailers`, async t => {
		const server = await createHttp2TestServer((stream, headers) => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
			stream.end(JSON.stringify(headers));
		});
		t.after(server.close);
		const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
		const fields = {
			connection: 'x-hop',
			'keep-alive': 'timeout=5',
			'proxy-connection': 'x-proxy-hop',
			'transfer-encoding': 'chunked',
			upgrade: 'websocket',
			'http2-settings': 'unused',
			'x-hop': 'removed',
			'x-proxy-hop': 'removed',
			te: 'trailers',
			'x-end-to-end': 'retained',
		};
		if (headerApi === 'Headers') {
			request.setHeaders(new Headers(fields));
		} else if (headerApi === 'Map') {
			request.setHeaders(new Map(Object.entries(fields)));
		} else {
			for (const [name, value] of Object.entries(fields)) {
				request.appendHeader(name, value);
			}
		}

		const received = JSON.parse(await collectHttp2ResponseBody(request)) as Record<string, string>;
		for (const name of Object.keys(fields)) {
			if (name !== 'te' && name !== 'x-end-to-end') {
				assert.strictEqual(Object.hasOwn(received, name), false, `Unexpected header ${name}`);
			}
		}

		assert.strictEqual(received.te, 'trailers');
		assert.strictEqual(received['x-end-to-end'], 'retained');
	});
}

for (const connectionFirst of [false, true]) {
	test(`http2 protocol removes Map connection-nominated fields listed ${connectionFirst ? 'after' : 'before'} Connection`, async t => {
		const server = await createHttp2TestServer((stream, headers) => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
			stream.end(JSON.stringify(headers));
		});
		t.after(server.close);
		const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
		const fields: Array<[string, string]> = [['X-First', 'removed'], ['x-second', 'removed']];
		const connection: [string, string] = ['Connection', ' X-FIRST , x-SECOND '];
		if (connectionFirst) {
			fields.unshift(connection);
		} else {
			fields.push(connection);
		}

		request.setHeaders(new Map([...fields, ['x-retained', 'yes']]));
		const received = JSON.parse(await collectHttp2ResponseBody(request)) as Record<string, string>;
		assert.strictEqual(Object.hasOwn(received, 'connection'), false);
		assert.strictEqual(Object.hasOwn(received, 'x-first'), false);
		assert.strictEqual(Object.hasOwn(received, 'x-second'), false);
		assert.strictEqual(received['x-retained'], 'yes');
	});
}

test('http2 protocol filters unsupported TE lists through native header mutation APIs', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(JSON.stringify(headers));
	});
	t.after(server.close);
	await Promise.all(['Headers', 'Map', 'appendHeader'].map(async headerApi => {
		const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
		if (headerApi === 'Headers') {
			request.setHeaders(new Headers({te: 'trailers, gzip'}));
		} else if (headerApi === 'Map') {
			request.setHeaders(new Map([['te', ['trailers', 'gzip']]]));
		} else {
			request.appendHeader('te', ['trailers', 'gzip']);
		}

		const received = JSON.parse(await collectHttp2ResponseBody(request)) as Record<string, string>;
		assert.strictEqual(Object.hasOwn(received, 'te'), false, `Unexpected te header for ${headerApi}`);
		assert.strictEqual(received[':method'], 'GET');
	}));
});

test('http2 canonicalizes case-insensitive TE trailers before creating the stream', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
		stream.end(String(headers.te));
	});
	t.after(server.close);
	const body = await got(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		retry: {limit: 0},
		headers: {te: 'Trailers'},
	}).text();

	assert.strictEqual(body, 'trailers');
});

for (const value of [' \tTRAILERS\t ', [' trailers ']]) {
	test(`http2 canonicalizes TE with optional whitespace ${JSON.stringify(value)}`, async t => {
		const server = await createHttp2TestServer((stream, headers) => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
			stream.end(String(headers.te));
		});
		t.after(server.close);
		const original = structuredClone(value);
		const body = await got(server.url, {
			http2: true,
			agent: {http2: false},
			https: {rejectUnauthorized: false},
			retry: {limit: 0},
			headers: {te: value},
		}).text();

		assert.strictEqual(body, 'trailers');
		assert.deepStrictEqual(value, original);
	});
}

for (const headerApi of ['Headers', 'Map', 'appendHeader']) {
	test(`http2 canonicalizes TE through ${headerApi}`, async t => {
		const server = await createHttp2TestServer((stream, headers) => {
			stream.respond({[http2.constants.HTTP2_HEADER_STATUS]: 200});
			stream.end(JSON.stringify(headers));
		});
		t.after(server.close);
		const request = http2Request(server.url, {agent: false, rejectUnauthorized: false});
		if (headerApi === 'Headers') {
			request.setHeaders(new Headers({te: 'Trailers'}));
		} else if (headerApi === 'Map') {
			request.setHeaders(new Map([['TE', ['\tTRAILERS ']]]));
		} else {
			request.appendHeader('TE', 'Trailers');
		}

		request.setHeader('x-retained', 'MixedCase');
		assert.strictEqual(request.getHeader('te'), 'trailers');
		const received = JSON.parse(await collectHttp2ResponseBody(request)) as Record<string, string>;
		assert.strictEqual(received.te, 'trailers');
		assert.strictEqual(received['x-retained'], 'MixedCase');
	});
}

test('http2 does not bind a completed request signal to the pooled session', async _t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	const abortController = new AbortController();

	try {
		await got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			signal: abortController.signal,
		});

		// The session is pooled now, so an abort must not reach requests that do not use the signal.
		const pending = got(server.url, {
			http2: true,
			https: {
				rejectUnauthorized: false,
			},
			retry: {
				limit: 0,
			},
		});

		abortController.abort();

		assert.strictEqual((await pending).body, 'ok');
	} finally {
		await server.close();
	}
});

test('http2 hides pseudo-headers from the request header accessors', async _t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({

			':status': 200,
		});
		stream.end(JSON.stringify(headers));
	});

	try {
		const request = http2Request(server.url, {rejectUnauthorized: false});
		request.setHeader('x-custom', 'value');

		assert.deepStrictEqual(request.getHeaderNames(), ['x-custom']);
		assert.deepStrictEqual(Object.keys(request.getHeaders()), ['x-custom']);

		assert.strictEqual(JSON.parse(await collectHttp2ResponseBody(request))['x-custom'], 'value');
	} finally {
		await server.close();
	}
});

test('http2 removeHeader drops the headers a connection header nominated', async _t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({

			':status': 200,
		});
		stream.end(JSON.stringify(headers));
	});

	try {
		const request = http2Request(server.url, {rejectUnauthorized: false});
		request.setHeader('connection', 'x-nominated');
		request.setHeader('x-nominated', 'first');
		assert.strictEqual(request.getHeader('x-nominated'), undefined);

		request.removeHeader('connection');
		request.setHeader('x-nominated', 'second');

		assert.strictEqual(request.getHeader('x-nominated'), 'second');

		assert.strictEqual(JSON.parse(await collectHttp2ResponseBody(request))['x-nominated'], 'second');
	} finally {
		await server.close();
	}
});

// The HTTP/2 client collapses several phases into one timer, so the reported phase has to
// come from the timeout that produced the smallest value.
for (const phase of ['lookup', 'connect', 'secureConnect', 'request'] as const) {
	test(`http2 reports a session setup timeout as the ${phase} phase`, async _t => {
		const certificate = await createCertificate({days: 1, selfSigned: true});
		const sockets = new Set<tls.TLSSocket>();
		// The handshake completes and then nothing happens, so the session setup never finishes.
		const server = tls.createServer({
			key: certificate.serviceKey,
			cert: certificate.certificate,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			ALPNProtocols: ['h2'],
		}, socket => {
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
			const error = await rejects(got(`https://localhost:${port}`, {
				http2: true,
				agent: {
					http2: false,
				},
				retry: {
					limit: 0,
				},
				timeout: {
					request: 2000,
					[phase]: 100,
				},
				https: {
					rejectUnauthorized: false,
				},
			}));

			assert.strictEqual(error?.name, 'TimeoutError');
			assert.strictEqual(error?.event, phase);
		} finally {
			for (const socket of sockets) {
				socket.destroy();
			}

			await closeServer(server);
		}
	});
}

// A session handed out without a capacity reservation must still keep the stream counts
// balanced, otherwise the counts drift negative and the server's stream limit is ignored.
test('http2 stream counts stay balanced for a session without a reservation', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.end('ok');
	});

	const agent = new Http2Agent();
	t.after(async () => {
		agent.destroy();
		await server.close();
	});

	const session = await agent.getSession(server.url, {rejectUnauthorized: false}) as SessionWithCounters;

	for (let index = 0; index < 3; index++) {
		// eslint-disable-next-line no-await-in-loop
		await new Promise<void>(resolve => {
			const stream = session.request({

				':path': `/${index}`,
			}, {endStream: false});
			stream.on('error', () => {});
			stream.resume();
			stream.once('close', () => {
				resolve();
			});
			stream.end();
		});

		assert.strictEqual(session.currentStreamCount, 0, `after request ${index + 1}`);
		assert.strictEqual(session.reservedStreamCount, 0, `after request ${index + 1}`);
	}
});

// `request.destroy()` from the documented `request` event tip cancels the h2 stream without
// an `aborted` event, so the response must be completed as aborted instead of hanging.
test('destroying an in-progress http2 request from the request event does not hang', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({

			':status': 200,
		});
		stream.write('partial');
	});
	t.after(async () => {
		await server.close();
	});

	const stream = got.stream(server.url, {
		http2: true,
		https: {
			rejectUnauthorized: false,
		},
		retry: {
			limit: 0,
		},
	});
	stream.on('request', request => {
		setTimeout(() => {
			request.destroy();
		}, 20);
	});

	const error = await new Promise<any>((resolve, reject) => {
		stream.once('error', resolve);
		stream.once('end', () => {
			reject(new Error('The stream ended without an error'));
		});
		setTimeout(() => {
			reject(new Error('The request did not settle after being destroyed'));
		}, 2000);
	});

	assert.strictEqual(error.name, 'ReadError');
	assert.strictEqual(error.code, 'ECONNRESET');
});
