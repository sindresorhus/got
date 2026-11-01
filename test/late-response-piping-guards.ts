import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import {RequestError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('all synchronous response listeners can prepare headers before a piped response sends them', withServer, async (_t, server, got) => {
	server.get('/upstream', (_request, response) => {
		response.writeHead(201, {'x-removed': 'remove', 'x-upstream': 'original'});
		response.end('upstream body');
	});
	server.get('/proxy', (_request, response) => {
		const upstream = got.stream('upstream').on('error', error => response.destroy(error));
		upstream.once('response', () => {
			upstream.pipe(response);
		});
		upstream.once('response', message => {
			delete message.headers['x-removed'];
			message.headers['x-upstream'] = 'updated';
			message.headers['x-added'] = 'added';
		});
	});

	const response = await got('proxy');
	assert.strictEqual(response.body, 'upstream body');
	assert.strictEqual(response.statusCode, 201);
	assert.strictEqual(response.headers['x-removed'], undefined);
	assert.strictEqual(response.headers['x-upstream'], 'updated');
	assert.strictEqual(response.headers['x-added'], 'added');
});

test('piping after awaiting the response preserves already-sent downstream metadata', withServer, async (_t, server, got) => {
	server.get('/upstream', (_request, response) => {
		response.writeHead(201, {'x-upstream': 'ignored'});
		response.end('upstream body');
	});
	server.get('/proxy', async (_request, response) => {
		const upstream = got.stream('upstream').on('error', error => response.destroy(error));
		await once(upstream, 'response');
		response.writeHead(202, {'x-downstream': 'retained'});
		upstream.pipe(response);
	});

	const response = await got('proxy');
	assert.strictEqual(response.body, 'upstream body');
	assert.strictEqual(response.statusCode, 202);
	assert.strictEqual(response.headers['x-downstream'], 'retained');
	assert.strictEqual(response.headers['x-upstream'], undefined);
});

test('piping a raw compressed response preserves its wire encoding and length', withServer, async (_t, server, got) => {
	const compressed = gzipSync('upstream body');
	server.get('/upstream', (_request, response) => {
		response.writeHead(201, {'content-encoding': 'gzip', 'content-length': compressed.byteLength});
		response.end(compressed);
	});
	server.get('/proxy', (_request, response) => {
		got.stream('upstream', {decompress: false}).on('error', error => response.destroy(error)).pipe(response);
	});

	const response = await got('proxy', {decompress: false});
	assert.deepStrictEqual(Buffer.from(response.rawBody), compressed);
	assert.strictEqual(response.statusCode, 201);
	assert.strictEqual(response.headers['content-encoding'], 'gzip');
	assert.strictEqual(response.headers['content-length'], String(compressed.byteLength));
});

test('an upstream failure still closes a destination added after awaiting the response', withServer, async (_t, server, got) => {
	const received = Promise.withResolvers<void>();
	const upstreamClosed = Promise.withResolvers<void>();
	let failUpstream = () => {};
	let failures = 0;
	server.get('/upstream', (_request, response) => {
		failUpstream = () => {
			response.destroy();
		};

		response.writeHead(200, {'content-length': 100});
		response.write('partial');
	});
	server.get('/proxy', async (_request, response) => {
		const upstream = got.stream('upstream', {retry: {limit: 0}});
		upstream.on('error', () => {
			failures++;
		});
		upstream.once('close', () => {
			upstreamClosed.resolve();
		});
		await once(upstream, 'response');
		upstream.pipe(response);
	});

	const result = got('proxy', {strictContentLength: false, retry: {limit: 0}}).on('downloadProgress', progress => {
		if (progress.transferred > 0) {
			received.resolve();
		}
	}).catch((error: unknown) => error);
	await received.promise;
	failUpstream();
	const error = await result;
	await upstreamClosed.promise;
	assert.ok(error instanceof RequestError);
	assert.strictEqual(error.code, 'ECONNRESET');
	assert.strictEqual(failures, 1);
});
