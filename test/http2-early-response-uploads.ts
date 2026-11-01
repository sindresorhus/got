import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import got from '../source/index.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import test from './helpers/test.js';

for (const statusCode of [200, 204]) {
	test(`an HTTP/2 ${statusCode} response EOF preserves a manually written upload`, async t => {
		const uploaded = Promise.withResolvers<string>();
		const server = await createHttp2TestServer(stream => {
			let body = '';
			stream.on('data', chunk => {
				body += chunk.toString();
			});
			stream.once('end', () => {
				uploaded.resolve(body);
			});
			stream.on('error', uploaded.reject);
			stream.respond({':status': statusCode});
			stream.end(statusCode === 200 ? 'early response' : undefined);
		});
		const request = got.stream.post(server.url, {
			http2: true,
			agent: {http2: false},
			https: {rejectUnauthorized: false},
			retry: {limit: 0},
		});
		t.after(async () => {
			request.destroy();
			await server.close();
		});
		let responseBody = '';
		const completedUploads: number[] = [];
		request.setEncoding('utf8');
		request.on('data', (chunk: string) => {
			responseBody += chunk;
		});
		request.on('uploadProgress', progress => {
			if (progress.percent === 1) {
				completedUploads.push(progress.transferred);
			}
		});
		const responseEnded = once(request, 'end');
		let writeCallbacks = 0;
		request.write('first', () => {
			writeCallbacks++;
		});
		await responseEnded;
		assert.equal(request.writableEnded, false);
		assert.equal(request.destroyed, false);
		assert.equal(responseBody, statusCode === 200 ? 'early response' : '');

		const finished = once(request, 'finish');
		let endCallbacks = 0;
		request.end('second', () => {
			endCallbacks++;
		});
		await finished;
		assert.equal(await uploaded.promise, 'firstsecond');
		assert.equal(writeCallbacks, 1);
		assert.equal(endCallbacks, 1);
		assert.deepEqual(completedUploads, [11]);
	});
}

test('an HTTP/2 response EOF preserves a configured asynchronous upload', async t => {
	const releaseUpload = Promise.withResolvers<void>();
	const uploaded = Promise.withResolvers<string>();
	const server = await createHttp2TestServer(stream => {
		let body = '';
		stream.on('data', chunk => {
			body += chunk.toString();
		});
		stream.once('end', () => {
			uploaded.resolve(body);
		});
		stream.on('error', uploaded.reject);
		stream.respond({':status': 200});
		stream.end('early response');
	});
	const request = got.stream.post(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		retry: {limit: 0},
		body: Readable.from((async function * () {
			yield 'first';
			await releaseUpload.promise;
			yield 'second';
		})()),
	});
	t.after(async () => {
		releaseUpload.resolve();
		request.destroy();
		await server.close();
	});
	const responseEnded = once(request, 'end');
	request.resume();
	await responseEnded;
	assert.equal(request.writableFinished, false);

	const finished = once(request, 'finish');
	releaseUpload.resolve();
	await finished;
	assert.equal(await uploaded.promise, 'firstsecond');
});

test('an HTTP/2 native request can abort a pending upload after response EOF', async t => {
	const uploadClosed = Promise.withResolvers<void>();
	const server = await createHttp2TestServer(stream => {
		stream.on('error', () => {});
		stream.once('close', uploadClosed.resolve);
		stream.resume();
		stream.respond({':status': 200});
		stream.end('early response');
	});
	const request = got.stream.post(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		retry: {limit: 0},
	});
	t.after(async () => {
		request.destroy();
		await server.close();
	});
	const nativeRequestReceived = once(request, 'request');
	const responseEnded = once(request, 'end');
	request.resume();
	request.write('first');
	await responseEnded;
	const [nativeRequest] = await nativeRequestReceived;
	assert.equal(nativeRequest.res.complete, true);
	assert.equal(nativeRequest.writableFinished, false);
	let abortEvents = 0;
	nativeRequest.on('abort', () => {
		abortEvents++;
	});
	const failed = once(request, 'error');
	const nativeClosed = once(nativeRequest, 'close');
	nativeRequest.abort();
	nativeRequest.abort();
	assert.equal(nativeRequest.aborted, true);
	assert.equal(nativeRequest.destroyed, true);
	await nativeClosed;
	await uploadClosed.promise;
	const [error] = await failed;
	assert.equal(error.code, 'ECONNRESET');
	assert.equal(request.destroyed, true);
	assert.equal(abortEvents, 1);
	assert.equal(nativeRequest.writableFinished, false);
});
