import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import type {IncomingMessage} from 'node:http';
import {PassThrough} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import ResponseLike from 'responselike';
import got, {ReadError} from '../source/index.js';
import test from './helpers/test.js';

for (const useHook of [true, false]) {
	test(`a ${useHook ? 'beforeRequest' : 'custom request'} response closed without an error rejects instead of hanging`, async t => {
		const source = Object.assign(new PassThrough(), {
			statusCode: 200,
			headers: {},
			url: 'http://example.invalid/',
		});
		const controller = new AbortController();
		t.after(() => {
			controller.abort();
			source.destroy();
		});
		const request = got(source.url, {
			signal: controller.signal,
			retry: {limit: 0},
			...(useHook ? {hooks: {beforeRequest: [() => source as unknown as IncomingMessage]}} : {request: () => source as unknown as IncomingMessage}),
		});
		const outcome = request.catch((error: unknown) => error);
		await setImmediate();
		source.write('unfinished body');
		const closed = once(source, 'close');
		source.destroy();
		await closed;
		await setImmediate();
		// Cancellation exposes a missing close transition without leaving a pending request in the test.
		controller.abort();
		const error = await outcome;
		assert.ok(error instanceof ReadError);
		assert.strictEqual(error.code, 'ECONNRESET');
	});
}

for (const contentEncoding of ['gzip', 'gzip, gzip']) {
	test(`an errorless premature ${contentEncoding} source close rejects through its decoder`, async t => {
		const source = Object.assign(new PassThrough(), {
			statusCode: 200,
			headers: {'content-encoding': contentEncoding},
			url: 'http://example.invalid/',
		});
		const controller = new AbortController();
		t.after(() => {
			controller.abort();
			source.destroy();
		});
		const request = got(source.url, {
			signal: controller.signal,
			retry: {limit: 0},
			request: () => source as unknown as IncomingMessage,
		});
		const outcome = request.catch((error: unknown) => error);
		await setImmediate();
		// A valid gzip header leaves the decoder waiting for the rest of its input.
		source.write(gzipSync('unfinished body').subarray(0, 10));
		const closed = once(source, 'close');
		source.destroy();
		await closed;
		await setImmediate();
		controller.abort();
		const error = await outcome;
		assert.ok(error instanceof ReadError);
		assert.strictEqual(error.code, 'ECONNRESET');
	});
}

test('a response declared complete still fails if it is destroyed before readable EOF', async _t => {
	const source = Object.assign(new PassThrough(), {
		statusCode: 200,
		headers: {},
		complete: true,
		url: 'http://example.invalid/',
	});
	const request = got(source.url, {
		retry: {limit: 0},
		request: () => source as unknown as IncomingMessage,
	});
	const failure = assert.rejects(request, error => error instanceof ReadError && error.code === 'ECONNRESET');
	await setImmediate();
	source.write('partial body');
	source.destroy();
	await failure;
	assert.strictEqual(source.readableAborted, true);
});

test('a completed buffered response remains readable when the outward consumer is paused', async _t => {
	const body = Buffer.alloc(64 * 1024, 'a');
	const source = new ResponseLike({
		statusCode: 200,
		headers: {},
		body,
		url: 'http://example.invalid/',
	});
	const download = got.stream(source.url, {
		retry: {limit: 0},
		hooks: {beforeRequest: [() => source]},
	});
	await once(download, 'readable');
	await setImmediate();
	assert.strictEqual(download.destroyed, false);
	assert.strictEqual(source.complete, true);
	assert.deepStrictEqual(Buffer.concat(await download.toArray()), body);
	assert.strictEqual(download.readableEnded, true);
});

test('an errorless premature response close retains strict content-length validation', async _t => {
	const source = Object.assign(new PassThrough(), {
		statusCode: 200,
		headers: {'content-length': '10'},
		url: 'http://example.invalid/',
	});
	const request = got(source.url, {
		strictContentLength: true,
		retry: {limit: 0},
		request: () => source as unknown as IncomingMessage,
	});
	const failure = assert.rejects(request, {code: 'ERR_HTTP_CONTENT_LENGTH_MISMATCH'});
	await setImmediate();
	source.write('abc');
	source.destroy();
	await failure;
});
