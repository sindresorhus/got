import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import got from '../source/index.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

test('an accepted early HTTP/2 error status still allows a configured stream upload to finish', async t => {
	const body = Buffer.alloc(1024 * 1024);
	const received = Promise.withResolvers<number>();
	const server = await createHttp2TestServer(stream => {
		let bytes = 0;
		stream.on('data', (chunk: Uint8Array) => {
			bytes += chunk.byteLength;
		});
		stream.once('end', () => {
			received.resolve(bytes);
		});
		stream.respond({':status': 413});
		stream.end('upload rejected');
	});
	t.after(server.close);
	let errors = 0;
	const request = got.stream.post(server.url, {
		http2: true,
		agent: {http2: false},
		https: {rejectUnauthorized: false},
		body,
		throwHttpErrors: false,
		retry: {limit: 0},
		hooks: {
			beforeError: [error => {
				errors++;
				return error;
			}],
		},
	});
	t.after(() => {
		request.destroy();
	});
	let responseBody = '';
	let finishes = 0;
	const completedUploads: number[] = [];
	request.setEncoding('utf8');
	request.on('data', (chunk: string) => {
		responseBody += chunk;
	});
	request.once('finish', () => {
		finishes++;
	});
	request.on('uploadProgress', progress => {
		if (progress.percent === 1) {
			completedUploads.push(progress.transferred);
		}
	});
	const responseEnded = once(request, 'end');
	const uploadFinished = once(request, 'finish');
	await Promise.all([responseEnded, uploadFinished]);
	const bytes = await received.promise;
	assert.strictEqual(bytes, body.byteLength);
	assert.strictEqual(responseBody, 'upload rejected');
	assert.strictEqual(request.response?.statusCode, 413);
	assert.strictEqual(request.destroyed, false);
	assert.strictEqual(finishes, 1);
	assert.deepStrictEqual(completedUploads, [body.byteLength]);
	assert.strictEqual(errors, 0);
});
