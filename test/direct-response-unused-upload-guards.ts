import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import http from 'node:http';
import {Readable} from 'node:stream';
import getStream from 'get-stream';
import ResponseLike from 'responselike';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const body of ['buffered body', Buffer.from('buffered body'), new TextEncoder().encode('buffered body')]) {
	test(`a direct response preserves completion for a ${typeof body === 'string' ? 'string' : body.constructor.name} body`, withServer, async (t, server, got) => {
		const request = got.stream.post('', {
			body,
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200, headers: {}, body: Buffer.from('cached response'), url: server.url,
				})],
			},
		});
		t.after(() => {
			request.destroy();
		});
		const finished = once(request, 'finish');
		assert.strictEqual(await getStream(request), 'cached response');
		await finished;
		assert.strictEqual(request.isReadonly, true);
		assert.strictEqual(request.writableFinished, true);
		assert.strictEqual(request.uploadProgress.transferred, 0);
	});
}

test('a direct response preserves queued manual upload callbacks', withServer, async (t, server, got) => {
	const request = got.stream.post('', {
		hooks: {
			beforeRequest: [() => new ResponseLike({
				statusCode: 200, headers: {}, body: Buffer.from('cached response'), url: server.url,
			})],
		},
	});
	t.after(() => {
		request.destroy();
	});
	const callbacks: string[] = [];
	const firstWritten = new Promise<void>((resolve, reject) => {
		request.write('first', error => {
			if (error) {
				reject(error);
				return;
			}

			callbacks.push('first');
			resolve();
		});
	});
	const secondWritten = new Promise<void>((resolve, reject) => {
		request.write('second', error => {
			if (error) {
				reject(error);
				return;
			}

			callbacks.push('second');
			resolve();
		});
	});
	const ended = new Promise<void>(resolve => {
		request.end(() => {
			callbacks.push('end');
			resolve();
		});
	});
	const [body] = await Promise.all([getStream(request), firstWritten, secondWritten, ended]);
	assert.strictEqual(body, 'cached response');
	assert.deepStrictEqual(callbacks, ['first', 'second', 'end']);
	assert.strictEqual(request.isReadonly, false);
	assert.strictEqual(request.writableFinished, true);
});

test('a direct response does not auto-end a manual POST upload', withServer, async (t, server, got) => {
	const request = got.stream.post('', {
		hooks: {
			beforeRequest: [() => new ResponseLike({
				statusCode: 200, headers: {}, body: Buffer.from('cached response'), url: server.url,
			})],
		},
	});
	t.after(() => {
		request.destroy();
	});
	let responseBody = '';
	request.setEncoding('utf8');
	request.on('data', (chunk: string) => {
		responseBody += chunk;
	});
	await once(request, 'end');
	assert.strictEqual(responseBody, 'cached response');
	assert.strictEqual(request.writableEnded, false);
	assert.strictEqual(request.isReadonly, false);
	const finished = once(request, 'finish');
	request.end('late upload');
	await finished;
	assert.strictEqual(request.writableFinished, true);
});

test('a native request returned by a hook still consumes its configured upload', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});
	let reads = 0;
	let released = 0;
	const body = new Readable({
		read() {
			reads++;
			this.push('native upload');
			this.push(null);
		},
		destroy(error, callback) {
			released++;
			callback(error);
		},
	});
	const response = await got.post('', {
		body,
		hooks: {
			beforeRequest: [options => http.request(options.url!, {method: options.method, headers: options.headers})],
		},
	});
	assert.strictEqual(response.body, 'native upload');
	assert.strictEqual(reads, 1);
	assert.strictEqual(released, 1);
});

test('a failed direct response transfers a fresh upload to the native retry', withServer, async (_t, server, got) => {
	let requests = 0;
	server.post('/', async (request, response) => {
		requests++;
		response.json({
			body: await getStream(request),
			header: request.headers['x-retry-body'],
			framing: request.headers['transfer-encoding'],
		});
	});
	let oldReleases = 0;
	let freshReleases = 0;
	const original = new Readable({
		read() {
			this.push(null);
		},
		destroy(error, callback) {
			oldReleases++;
			callback(error);
		},
	});
	const replacement = new Readable({
		read() {
			this.push('fresh upload');
			this.push(null);
		},
		destroy(error, callback) {
			freshReleases++;
			callback(error);
		},
	});
	const response = await got.post('', {
		body: original,
		retry: {limit: 1, methods: ['POST'], calculateDelay: () => 1},
		request: () => new ResponseLike({
			statusCode: 500, headers: {}, body: Buffer.from('cached failure'), url: server.url,
		}),
		hooks: {
			beforeRetry: [error => {
				error.options.request = undefined;
				error.options.body = replacement;
				error.options.headers['x-retry-body'] = 'fresh';
			}],
		},
	});
	assert.deepStrictEqual(JSON.parse(response.body), {body: 'fresh upload', header: 'fresh', framing: 'chunked'});
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(requests, 1);
	assert.strictEqual(oldReleases, 1);
	assert.strictEqual(freshReleases, 1);
});
