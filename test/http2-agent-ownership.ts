import assert from 'node:assert/strict';
import {once} from 'node:events';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import {setImmediate} from 'node:timers/promises';
import {Http2Agent, auto} from '../source/core/utils/http2-client.js';
import closed from './helpers/closed.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import test from './helpers/test.js';

test('an HTTP/2 request closes its response and request after a session failure', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.respond({':status': 200});
		stream.write('partial body');
	});
	const agent = new Http2Agent();
	const sessionReady = once(agent, 'session');
	t.after(async () => {
		agent.destroy();
		await server.close();
	});
	const request = await auto(server.url, {agent: {http2: agent}, rejectUnauthorized: false});
	const events: string[] = [];
	request.once('error', () => {
		events.push('request error');
	});
	request.once('close', () => {
		events.push('request close');
	});
	const received = once(request, 'response');
	request.end();
	const [response] = await received;
	response.on('error', () => {});
	response.once('close', () => {
		events.push('response close');
	});
	response.resume();
	const [session] = await sessionReady;
	const sessionClosed = closed(session);
	agent.destroy(new Error('Session failed'));
	await sessionClosed;
	await setImmediate();
	assert.deepStrictEqual(events, ['request error', 'response close', 'request close']);
	assert.strictEqual(response.destroyed, true);
});

test('an HTTP/2 session failure closes a paused response without waiting for its end', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.respond({':status': 200});
		stream.write('buffered body');
	});
	const agent = new Http2Agent();
	t.after(async () => {
		agent.destroy();
		await server.close();
	});
	const request = await auto(server.url, {agent: {http2: agent}, rejectUnauthorized: false});
	const cause = new Error('Session failed with a paused response');
	const errors: Error[] = [];
	request.on('error', error => {
		errors.push(error);
	});
	const requestClosed = closed(request);
	const received = once(request, 'response');
	request.end();
	const [response] = await received;
	const responseClosed = closed(response);
	agent.destroy(cause);
	await Promise.all([requestClosed, responseClosed]);
	assert.deepStrictEqual(errors, [cause]);
	assert.strictEqual(response.readableEnded, false);
	assert.strictEqual(response.destroyed, true);
	assert.strictEqual(response.complete, false);
});

test('an HTTP/2 request preserves a completed paused response until it is read', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.respond({':status': 200});
		stream.end('complete buffered body');
	});
	const agent = new Http2Agent();
	t.after(async () => {
		agent.destroy();
		await server.close();
	});
	const request = await auto(server.url, {agent: {http2: agent}, rejectUnauthorized: false});
	const events: string[] = [];
	const requestClosed = closed(request);
	request.once('close', () => {
		events.push('request close');
	});
	const received = once(request, 'response');
	request.end();
	const [response] = await received;
	response.once('end', () => {
		events.push('response end');
	});
	response.once('close', () => {
		events.push('response close');
	});
	const nativeStream = (response).stream;
	await closed(nativeStream);
	assert.deepStrictEqual(events, []);
	assert.strictEqual(response.complete, true);
	assert.strictEqual(response.destroyed, false);
	assert.strictEqual((await response.toArray()).join(''), 'complete buffered body');
	await requestClosed;
	assert.deepStrictEqual(events, ['response end', 'response close', 'request close']);
});

test('destroying the HTTP/2 agent closes active sessions excluded from its reuse pool', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.respond({':status': 200});
		stream.write('pending response');
	});
	const agent = new Http2Agent();
	let sessionClosed: Promise<unknown[]> | undefined;
	agent.once('session', session => {
		sessionClosed = closed(session);
	});
	t.after(async () => {
		agent.destroy();
		await server.close();
	});
	const request = await auto(server.url, {
		agent: {http2: agent}, rejectUnauthorized: false,
		createConnection(options: tls.ConnectionOptions) {
			return tls.connect(options);
		},
	});
	request.on('error', () => {});
	const response = once(request, 'response');
	request.end();
	const [incoming] = await response;
	incoming.on('error', () => {});
	incoming.resume();
	assert.strictEqual(agent.sessionCount, 1);
	assert.strictEqual(agent.sessions.size, 0);
	const failure = once(request, 'error', {signal: AbortSignal.timeout(500)});
	const cause = new Error('Agent shutdown');
	agent.destroy(cause);
	const [error] = await failure;
	assert.strictEqual(error, cause);
	assert.ok(sessionClosed);
	await sessionClosed;
	assert.strictEqual(agent.sessionCount, 0);
	assert.strictEqual(agent.pendingSessions.size, 0);
	assert.strictEqual(agent.emptySessionCount, 0);
});

test('destroying the HTTP/2 agent releases pooled, unpooled, pending, and queued operations', async t => {
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.respond({':status': 200});
		stream.write('pending response');
	});
	const sockets = new Set<net.Socket>();
	const blackhole = net.createServer(socket => {
		sockets.add(socket);
		socket.resume();
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});
	blackhole.listen(0, '127.0.0.1');
	await once(blackhole, 'listening');
	const agent = new Http2Agent({maxSessions: 3});
	t.after(async () => {
		agent.destroy();
		for (const socket of sockets) {
			socket.destroy();
		}

		await server.close();
		await new Promise<void>((resolve, reject) => {
			blackhole.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	});
	const cause = new Error('Stop all agent operations');
	const requestFailures: Array<Promise<void>> = [];
	const sessionClosures: Array<Promise<unknown[]>> = [];
	agent.on('session', session => {
		sessionClosures.push(closed(session));
	});
	for (const customConnection of [false, true]) {
		// eslint-disable-next-line no-await-in-loop
		const request = await auto(server.url, {
			agent: {http2: agent}, rejectUnauthorized: false,
			...(customConnection && {
				createConnection(options: tls.ConnectionOptions) {
					return tls.connect(options);
				},
			}),
		});
		request.on('error', () => {});
		const response = once(request, 'response');
		request.end();
		// eslint-disable-next-line no-await-in-loop
		const [incoming] = await response;
		incoming.on('error', () => {});
		incoming.resume();
		requestFailures.push(once(request, 'error').then(([error]) => {
			assert.strictEqual(error, cause);
		}));
	}

	const {port} = blackhole.address() as net.AddressInfo;
	const accepted = once(blackhole, 'connection');
	const pending = agent.getSession(`https://127.0.0.1:${port}`, {rejectUnauthorized: false});
	const pendingFailure = assert.rejects(pending, error => error === cause);
	await accepted;
	const queued = agent.getSession(server.url, {rejectUnauthorized: false, servername: 'queued.example'});
	const queuedFailure = assert.rejects(queued, error => error === cause);
	assert.strictEqual(agent.sessionCount, 3);
	assert.strictEqual(agent.sessions.size, 1);
	assert.strictEqual(agent.pendingSessions.size, 1);
	assert.strictEqual(agent.queue.length, 1);
	sessionClosures.push(closed([...agent.pendingSessions][0]!));
	agent.destroy(cause);
	await Promise.all([...requestFailures, ...sessionClosures, pendingFailure, queuedFailure]);
	assert.strictEqual(agent.sessionCount, 0);
	assert.strictEqual(agent.sessions.size, 0);
	assert.strictEqual(agent.pendingSessions.size, 0);
	assert.strictEqual(agent.pendingSessionEntries.size, 0);
	assert.strictEqual(agent.emptySessionCount, 0);
	assert.strictEqual(agent.queue.length, 0);
});

test('destroying an HTTP/2 agent leaves caller-supplied sessions usable', async t => {
	let responseStream: http2.ServerHttp2Stream | undefined;
	const server = await createHttp2TestServer(stream => {
		responseStream = stream;
		stream.respond({':status': 200});
		stream.write('before shutdown, ');
	});
	const session = http2.connect(server.url, {rejectUnauthorized: false});
	const agent = new Http2Agent();
	t.after(async () => {
		agent.destroy();
		session.destroy();
		await server.close();
	});
	const request = await auto(server.url, {h2session: session, agent: {http2: agent}});
	request.on('error', () => {});
	const response = once(request, 'response');
	request.end();
	const [incoming] = await response;
	incoming.setEncoding('utf8');
	assert.strictEqual(agent.sessionCount, 0);
	agent.destroy(new Error('Stop only agent-owned sessions'));
	assert.strictEqual(session.closed, false);
	assert.strictEqual(session.destroyed, false);
	responseStream!.end('after shutdown');
	assert.strictEqual((await incoming.toArray()).join(''), 'before shutdown, after shutdown');
	assert.strictEqual(incoming.complete, true);
});

test('synchronous HTTP/2 connection failures do not create owned sessions', async t => {
	const agent = new Http2Agent();
	t.after(() => {
		agent.destroy();
	});
	const cause = new Error('Connection creation failed');
	await assert.rejects(agent.getSession('https://example.com', {
		createConnection() {
			throw cause;
		},
	}), error => error === cause);
	assert.strictEqual(agent.sessionCount, 0);
	assert.strictEqual(agent.pendingSessions.size, 0);
	assert.strictEqual(agent.pendingSessionEntries.size, 0);
	assert.strictEqual(agent.sessions.size, 0);
	assert.strictEqual(agent.queue.length, 0);
});
