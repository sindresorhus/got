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

for (const contentEncoding of ['gzip', 'gzip, gzip']) {
	test(`a malformed ${contentEncoding} response keeps its decoder error`, async _t => {
		const source = new ResponseLike({
			statusCode: 200,
			headers: {'content-encoding': contentEncoding},
			body: contentEncoding === 'gzip' ? Buffer.from('malformed compressed body') : gzipSync('malformed compressed body'),
			url: 'http://example.invalid/',
		});
		await assert.rejects(got(source.url, {
			retry: {limit: 0},
			hooks: {beforeRequest: [() => source]},
		}), error => error instanceof ReadError && error.cause instanceof Error && Reflect.get(error.cause, 'code') === 'Z_DATA_ERROR');
		assert.strictEqual(source.destroyed, true);
	});

	test(`aborting a ${contentEncoding} response releases its source`, async t => {
		const source = Object.assign(new PassThrough(), {
			statusCode: 200,
			headers: {'content-encoding': contentEncoding},
			url: 'http://example.invalid/',
		});
		const sourceClosed = once(source, 'close');
		const controller = new AbortController();
		t.after(() => {
			controller.abort();
			source.destroy();
		});
		const request = got(source.url, {
			signal: controller.signal,
			retry: {limit: 0},
			hooks: {beforeRequest: [() => source as unknown as IncomingMessage]},
		});
		const rejected = assert.rejects(request, {name: 'AbortError'});
		await setImmediate();
		controller.abort();
		await rejected;
		await sourceClosed;
		assert.strictEqual(source.destroyed, true);
	});

	test(`destroying a ${contentEncoding} download releases its source`, async t => {
		const source = Object.assign(new PassThrough(), {
			statusCode: 200,
			headers: {'content-encoding': contentEncoding},
			url: 'http://example.invalid/',
		});
		const sourceClosed = once(source, 'close');
		t.after(() => {
			source.destroy();
		});
		const download = got.stream(source.url, {
			retry: {limit: 0},
			hooks: {beforeRequest: [() => source as unknown as IncomingMessage]},
		});
		const cause = new Error('Download stopped');
		const rejected = assert.rejects(download.toArray(), {message: cause.message});
		await setImmediate();
		download.destroy(cause);
		await rejected;
		await sourceClosed;
		assert.strictEqual(source.destroyed, true);
	});
}
