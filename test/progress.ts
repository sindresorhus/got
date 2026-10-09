import process from 'node:process';
import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import stream, {Readable} from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {once} from 'node:events';
// @ts-expect-error Fails to find slow-stream/index.d.ts
import SlowStream from 'slow-stream';
import getStream from 'get-stream';
import {temporaryFile} from 'tempy';
import is from '@sindresorhus/is';
import type {Handler} from 'express';
import {chunk, chunkFromAsync} from 'chunk-data';
import {type Progress, type NormalizedOptions} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const checkEvents = (_t: TestContext, events: Progress[], bodySize?: number) => {
	assert.strictEqual(events.length >= 2, true);

	let lastEvent = events.shift()!;
	if (!is.number(bodySize)) {
		assert.strictEqual(lastEvent.percent, 0);
	}

	for (const [index, event] of events.entries()) {
		const isLastEvent = index === events.length - 1;
		if (is.number(bodySize)) {
			assert.strictEqual(event.percent, event.transferred / bodySize);
			assert.strictEqual(event.percent > lastEvent.percent, true);
			assert.strictEqual(event.transferred > lastEvent.transferred, true);
		} else if (isLastEvent) {
			assert.strictEqual(event.percent, 1);
			assert.strictEqual(event.transferred, lastEvent.transferred);
			assert.strictEqual(event.total, event.transferred);
		} else {
			assert.strictEqual(event.percent, 0);
			assert.strictEqual(event.transferred > lastEvent.transferred, true);
		}

		lastEvent = event;
	}
};

const file = Buffer.alloc(1024 * 1024 * 2);

const downloadEndpoint: Handler = (_request, response) => {
	response.setHeader('content-length', file.length);

	(async () => {
		try {
			await streamPipeline(
				stream.Readable.from(file),
				new SlowStream({maxWriteInterval: 50}),
				response,
			);
		} catch {}

		response.end();
	})();
};

const noTotalEndpoint: Handler = (_request, response) => {
	response.write('hello');
	response.end();
};

const uploadEndpoint: Handler = (request, response) => {
	(async () => {
		try {
			await streamPipeline(
				request,
				new SlowStream({maxWriteInterval: 100}),
			);
		} catch {}

		response.end();
	})();
};

test('download progress', withServer, async (t, server, got) => {
	server.get('/', downloadEndpoint);

	const events: Progress[] = [];

	const {body} = await got({responseType: 'buffer'})
		.on('downloadProgress', event => {
			events.push(event);
		});

	checkEvents(t, events, body.length);
});

test('download progress - missing total size', withServer, async (t, server, got) => {
	server.get('/', noTotalEndpoint);

	const events: Progress[] = [];
	await got('').on('downloadProgress', (event: Progress) => {
		events.push(event);
	});

	assert.strictEqual(events[0]?.total, undefined);
	checkEvents(t, events);
});

test('download progress - reports total of 0 for `content-length: 0` responses', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {'content-length': '0'});
		response.end();
	});

	const events: Progress[] = [];
	await got('').on('downloadProgress', (event: Progress) => {
		events.push(event);
	});

	assert.strictEqual(events.length > 0, true);
	for (const event of events) {
		assert.strictEqual(event.total, 0);
		assert.strictEqual(event.transferred, 0);
		assert.strictEqual(event.percent, 1);
	}
});

test('download progress - stream', withServer, async (t, server, got) => {
	server.get('/', downloadEndpoint);

	const events: Progress[] = [];

	const stream = got.stream({responseType: 'buffer'})
		.on('downloadProgress', event => {
			events.push(event);
		});
	await getStream(stream);

	checkEvents(t, events, file.length);
});

test('upload progress - file', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	await got.post({body: file}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, file.length);
});

test('upload progress - file stream', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const path = temporaryFile();
	fs.writeFileSync(path, file);

	const {size} = await promisify(fs.stat)(path);

	const events: Progress[] = [];
	await got.post({
		body: fs.createReadStream(path),
		headers: {
			'content-length': size.toString(),
		},
	})
		.on('uploadProgress', (event: Progress) => {
			events.push(event);
		});

	checkEvents(t, events, file.length);
});

test('upload progress - form data', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const body = new FormData();
	body.set('key', 'value');
	body.set('file', new File([file], 'file'));
	await got.post({body}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events);
});

test('upload progress - json', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const body = JSON.stringify({key: 'value'});
	const size = Buffer.byteLength(body);
	const events: Progress[] = [];
	await got.post({body}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, size);
});

test('upload progress - measures bytes correctly for non-UTF-8 encoded strings', withServer, async (_t, server, got) => {
	server.post('/', uploadEndpoint);

	// String with emoji - 'Hello 👋' is 10 bytes in UTF-8, but 16 bytes in UTF-16LE
	const text = 'Hello 👋';
	const utf8Size = Buffer.from(text, 'utf8').byteLength; // 10 bytes
	const utf16Size = Buffer.from(text, 'utf16le').byteLength; // 16 bytes

	assert.strictEqual(utf8Size, 10);
	assert.strictEqual(utf16Size, 16);

	const events: Progress[] = [];

	// Upload as UTF-8 (default)
	await got.post({body: text}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	// Verify the progress measures UTF-8 bytes correctly
	const finalEvent = events.at(-1)!;
	assert.strictEqual(finalEvent.transferred, utf8Size);
	assert.strictEqual(finalEvent.total, utf8Size);
});

test('upload progress - stream with known body size', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	const options = {
		headers: {'content-length': file.length.toString()},
	};

	const request = got.stream.post(options)
		.on('uploadProgress', event => {
			events.push(event);
		});
	await streamPipeline(stream.Readable.from(file), request);
	await getStream(request);

	checkEvents(t, events, file.length);
});

test('upload progress - stream with unknown body size', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const request = got.stream.post('')
		.on('uploadProgress', event => {
			events.push(event);
		});
	await streamPipeline(stream.Readable.from(file), request);
	await getStream(request);

	assert.strictEqual(events[0]?.total, undefined);
	checkEvents(t, events);
});

test('upload progress - no body', withServer, async (_t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	await got.post('').on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	assert.deepStrictEqual(events, [
		{
			percent: 0,
			transferred: 0,
			total: undefined,
		},
		{
			percent: 1,
			transferred: 0,
			total: 0,
		},
	]);
});

test('upload progress - no events when immediately removed listener', withServer, async (_t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const listener = (event: Progress) => {
		events.push(event);
	};

	const promise = got.post('')
		.on('uploadProgress', listener)
		.off('uploadProgress', listener);
	await promise;

	assert.strictEqual(events.length, 0);
});

test('upload progress - one event when removed listener', withServer, async (_t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const promise = got.post('');

	const listener = (event: Progress) => {
		events.push(event);
		void promise.off('uploadProgress', listener);
	};

	void promise.on('uploadProgress', listener);
	await promise;

	assert.deepStrictEqual(events, [
		{
			percent: 0,
			transferred: 0,
			total: undefined,
		},
	]);
});

test('does not emit uploadProgress after cancelation', withServer, async (_t, server, got) => {
	server.post('/', () => {});

	const stream = got.stream.post();

	stream.once('uploadProgress', () => { // 0%
		stream.once('uploadProgress', () => { // 'foo'
			stream.write('bar');

			process.nextTick(() => {
				process.nextTick(() => {
					stream.on('uploadProgress', () => {
						assert.fail('Emitted uploadProgress after cancelation');
					});

					stream.destroy();
				});
			});
		});
	});

	stream.write('foo');
	await once(stream, 'close');
});

test('upload progress - chunk generator with buffer', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	await got.post({
		body: chunk(file, 65_536),
		headers: {
			'content-length': file.length.toString(),
		},
	})
		.on('uploadProgress', (event: Progress) => {
			events.push(event);
		});

	checkEvents(t, events, file.length);

	// Ensure we got more than just 0% and 100%
	assert.strictEqual(events.length > 2, true, `Expected more than 2 events with chunk, got ${events.length}`);
});

test('upload progress - chunkFromAsync async generator with stream', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	await got.post({
		body: chunkFromAsync(stream.Readable.from([file]), 65_536),
		headers: {
			'content-length': file.length.toString(),
		},
	})
		.on('uploadProgress', (event: Progress) => {
			events.push(event);
		});

	checkEvents(t, events, file.length);

	// Ensure we got more than just 0% and 100%
	assert.strictEqual(events.length > 2, true, `Expected more than 2 events with chunkFromAsync, got ${events.length}`);
});

test('upload progress - buffer body', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	const body = Buffer.alloc(1024 * 256); // 256 KB
	await got.post({
		body,
		headers: {'content-length': body.byteLength.toString()},
	}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, body.byteLength);

	// Ensure we got more than just 0% and 100%
	assert.strictEqual(events.length > 2, true, `Expected more than 2 events with buffer body, got ${events.length}`);
});

test('upload progress - typed array body', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	const body = new Uint8Array(1024 * 256); // 256 KB
	await got.post({
		body,
		headers: {'content-length': body.byteLength.toString()},
	}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, body.byteLength);

	// Ensure we got more than just 0% and 100%
	assert.strictEqual(events.length > 2, true, `Expected more than 2 events with typed array body, got ${events.length}`);
});

test('upload progress - small json option', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	const payload = {key: 'value'};
	const size = Buffer.byteLength(JSON.stringify(payload));
	await got.post({json: payload}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, size);
});

test('upload progress - json option', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	const payload = {key: '.'.repeat(1e6)};
	const size = Buffer.byteLength(JSON.stringify(payload));
	await got.post({json: payload}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, size);

	// Ensure we got more than just 0% and 100%
	assert.strictEqual(events.length > 2, true, `Expected more than 2 events with json option, got ${events.length}`);
});

test('upload progress - form option', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];
	const payload = {key: '.'.repeat(1e6)};
	const size = Buffer.byteLength(new URLSearchParams(payload).toString());
	await got.post({form: payload}).on('uploadProgress', (event: Progress) => {
		events.push(event);
	});

	checkEvents(t, events, size);

	// Ensure we got more than just 0% and 100%
	assert.strictEqual(events.length > 2, true, `Expected more than 2 events with form option, got ${events.length}`);
});

const echoHandler: Handler = async (request, response) => {
	const chunks = await request.toArray();
	response.end(Buffer.concat(chunks).toString());
};

for (const body of ['a replacement body', 'x', '', '你好 👋', 'x'.repeat(200_000)]) {
	for (const useStream of [false, true]) {
		test(`upload progress uses the ${Buffer.byteLength(body)}-byte replacement body in ${useStream ? 'stream' : 'promise'} mode`, withServer, async (_t, server, got) => {
			server.post('/', echoHandler);

			const events: Progress[] = [];
			const options = {
				body: 'old',
				hooks: {
					beforeRequest: [async (options: NormalizedOptions) => {
						await delay(1);
						options.body = body;
						options.headers['content-length'] = String(Buffer.byteLength(body));
					}],
				},
			};

			let responseBody: string;
			if (useStream) {
				const request = got.stream.post(options);
				request.on('uploadProgress', progress => {
					events.push(progress);
				});

				const chunks = await request.toArray();
				responseBody = Buffer.concat(chunks).toString();
			} else {
				const promise = got.post(options).on('uploadProgress', progress => {
					events.push(progress);
				});

				responseBody = (await promise).body;
			}

			assert.strictEqual(responseBody, body);
			assert.strictEqual(events.length >= 2, true);
			for (const event of events) {
				assert.strictEqual(event.total, Buffer.byteLength(body));
				assert.strictEqual(event.percent, body.length === 0 ? 1 : event.transferred / Buffer.byteLength(body));
			}

			assert.deepStrictEqual(events.at(-1), {percent: 1, transferred: Buffer.byteLength(body), total: Buffer.byteLength(body)});
		});
	}
}

for (const removeLength of [false, true]) {
	test(`upload progress clears stale size when a hook ${removeLength ? 'removes content-length' : 'sets transfer-encoding'}`, withServer, async (_t, server, got) => {
		const body = 'a streamed replacement';
		server.post('/', echoHandler);

		const events: Progress[] = [];
		const response = await got.post({
			body: 'old',
			hooks: {
				beforeRequest: [options => {
					options.body = Readable.from([body]);
					if (removeLength) {
						delete options.headers['content-length'];
					} else {
						options.headers['transfer-encoding'] = 'chunked';
					}
				}],
			},
		}).on('uploadProgress', progress => {
			events.push(progress);
		});

		assert.strictEqual(response.body, 'a streamed replacement');
		assert.strictEqual(events.length >= 2, true);
		assert.strictEqual(events[0]!.total, undefined);
		assert.strictEqual(events[0]!.percent, 0);
		assert.deepStrictEqual(events.at(-1), {percent: 1, transferred: Buffer.byteLength(body), total: Buffer.byteLength(body)});
	});
}

const decodedPayload = Buffer.from('compressible payload '.repeat(4000));
const gzippedPayload = gzipSync(decodedPayload);

const gzipEndpoint: Handler = (_request, response) => {
	response.writeHead(200, {
		'content-encoding': 'gzip',
		'content-length': gzippedPayload.length,
	});

	// Several writes so the client sees more than one chunk.
	const third = Math.ceil(gzippedPayload.length / 3);
	response.write(gzippedPayload.subarray(0, third));
	response.write(gzippedPayload.subarray(third, third * 2));
	response.end(gzippedPayload.subarray(third * 2));
};

test('download progress of a decompressed response counts decoded bytes and learns the total at the end', withServer, async (_t, server, got) => {
	server.get('/', gzipEndpoint);

	const events: Progress[] = [];
	const {body} = await got({responseType: 'buffer'}).on('downloadProgress', event => {
		events.push(event);
	});

	assert.deepStrictEqual(body, new Uint8Array(decodedPayload));
	assert.notStrictEqual(gzippedPayload.length, decodedPayload.length);

	const finalEvent = events.at(-1)!;
	assert.deepStrictEqual(finalEvent, {percent: 1, transferred: decodedPayload.length, total: decodedPayload.length});

	const intermediateEvents = events.slice(0, -1);
	assert.strictEqual(intermediateEvents.length >= 2, true);
	for (const [index, event] of intermediateEvents.entries()) {
		// The wire `content-length` describes compressed bytes, so it is not reported as the total.
		assert.strictEqual(event.total, undefined);
		assert.strictEqual(event.percent, 0);
		if (index > 0) {
			assert.strictEqual(event.transferred >= intermediateEvents[index - 1]!.transferred, true);
		}
	}
});

test('download progress with decompression disabled counts wire bytes against `content-length`', withServer, async (_t, server, got) => {
	server.get('/', gzipEndpoint);

	const events: Progress[] = [];
	const {body} = await got({responseType: 'buffer', decompress: false}).on('downloadProgress', event => {
		events.push(event);
	});

	assert.deepStrictEqual(body, new Uint8Array(gzippedPayload));
	for (const event of events) {
		assert.strictEqual(event.total, gzippedPayload.length);
	}

	assert.deepStrictEqual(events[0], {percent: 0, transferred: 0, total: gzippedPayload.length});
	assert.deepStrictEqual(events.at(-1), {percent: 1, transferred: gzippedPayload.length, total: gzippedPayload.length});
});

test('download progress restarts for a retried attempt', withServer, async (_t, server, got) => {
	let requestCount = 0;
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.writeHead(503, {'content-length': 4});
			response.end('fail');
			return;
		}

		response.writeHead(200, {'content-length': 5});
		response.end('hello');
	});

	const events: Progress[] = [];
	const {body} = await got({retry: {limit: 1, backoffLimit: 0}}).on('downloadProgress', event => {
		events.push(event);
	});

	assert.strictEqual(body, 'hello');
	assert.strictEqual(requestCount, 2);

	const firstRetriedEventIndex = events.findIndex(event => event.total === 5);
	assert.strictEqual(firstRetriedEventIndex > 0, true);
	assert.deepStrictEqual(events[firstRetriedEventIndex], {percent: 0, transferred: 0, total: 5});
	assert.strictEqual(events.slice(firstRetriedEventIndex).every(event => event.total === 5), true);
	assert.deepStrictEqual(events.at(-1), {percent: 1, transferred: 5, total: 5});
});

test('upload progress restarts when a 307 redirect replays the body', withServer, async (_t, server, got) => {
	server.post('/', async (request, response) => {
		await request.toArray();
		response.writeHead(307, {location: '/target'});
		response.end();
	});

	server.post('/target', echoHandler);

	const events: Progress[] = [];
	const {body} = await got.post({body: 'foobar'}).on('uploadProgress', event => {
		events.push(event);
	});

	assert.strictEqual(body, 'foobar');
	assert.deepStrictEqual(events, [
		{percent: 0, transferred: 0, total: 6},
		{percent: 1, transferred: 6, total: 6},
		{percent: 0, transferred: 0, total: 6},
		{percent: 1, transferred: 6, total: 6},
	]);
});

test('upload progress with explicit chunked encoding reports the total only when done', withServer, async (_t, server, got) => {
	server.post('/', echoHandler);

	const events: Progress[] = [];
	const {body} = await got.post({
		body: 'abcd',
		headers: {'transfer-encoding': 'chunked'},
	}).on('uploadProgress', event => {
		events.push(event);
	});

	assert.strictEqual(body, 'abcd');
	assert.strictEqual(events.slice(0, -1).every(event => event.total === undefined && event.percent === 0), true);
	assert.deepStrictEqual(events.at(-1), {percent: 1, transferred: 4, total: 4});
});

test('promise emits final upload and download progress before `response`', withServer, async (_t, server, got) => {
	server.post('/', echoHandler);

	const events: string[] = [];
	await got.post({body: 'hello'})
		.on('uploadProgress', event => {
			events.push(`upload:${event.percent}`);
		})
		.on('downloadProgress', event => {
			events.push(`download:${event.percent}`);
		})
		.on('response', () => {
			events.push('response');
		});

	assert.strictEqual(events.at(-1), 'response');
	assert.strictEqual(events.indexOf('upload:1') < events.indexOf('download:0'), true);
	assert.strictEqual(events.indexOf('download:1') < events.indexOf('response'), true);
	assert.strictEqual(events.filter(event => event === 'download:1').length, 1);
	assert.strictEqual(events.filter(event => event === 'upload:1').length, 1);
});
