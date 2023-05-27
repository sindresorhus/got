import process from 'node:process';
import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import stream from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import fs from 'node:fs';
// @ts-expect-error Fails to find slow-stream/index.d.ts
import SlowStream from 'slow-stream';
import getStream from 'get-stream';
import FormData from 'form-data';
import {temporaryFile} from 'tempy';
import is from '@sindresorhus/is';
import test, {type ExecutionContext} from 'ava';
import type {Handler} from 'express';
import {pEvent} from 'p-event';
import type {Progress} from '../source/index.js';
import withServer from './helpers/with-server.js';

const checkEvents = (t: ExecutionContext, events: Progress[], bodySize?: number) => {
	t.true(events.length >= 2);

	let lastEvent = events.shift()!;

	if (!is.number(bodySize)) {
		t.is(lastEvent.percent, 0);
	}

	for (const [index, event] of events.entries()) {
		const isLastEvent = index === events.length - 1;

		if (is.number(bodySize)) {
			t.is(event.percent, event.transferred / bodySize);
			t.true(event.percent > lastEvent.percent);
			t.true(event.transferred > lastEvent.transferred);
		} else if (isLastEvent) {
			t.is(event.percent, 1);
			t.is(event.transferred, lastEvent.transferred);
			t.is(event.total, event.transferred);
		} else {
			t.is(event.percent, 0);
			t.true(event.transferred > lastEvent.transferred);
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
		.on('downloadProgress', event => events.push(event));

	checkEvents(t, events, body.length);
});

test('download progress - missing total size', withServer, async (t, server, got) => {
	server.get('/', noTotalEndpoint);

	const events: Progress[] = [];

	await got('').on('downloadProgress', (event: Progress) => events.push(event));

	t.is(events[0]?.total, undefined);
	checkEvents(t, events);
});

test('download progress - stream', withServer, async (t, server, got) => {
	server.get('/', downloadEndpoint);

	const events: Progress[] = [];

	const stream = got.stream({responseType: 'buffer'})
		.on('downloadProgress', event => events.push(event));

	await getStream(stream);

	checkEvents(t, events, file.length);
});

test('upload progress - file', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	await got.post({body: file}).on('uploadProgress', (event: Progress) => events.push(event));

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
		.on('uploadProgress', (event: Progress) => events.push(event));

	checkEvents(t, events, file.length);
});

test('upload progress - form data', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const body = new FormData();
	body.append('key', 'value');
	body.append('file', file);

	const size = await promisify(body.getLength.bind(body))();

	await got.post({body}).on('uploadProgress', (event: Progress) => events.push(event));

	checkEvents(t, events, size);
});

test('upload progress - json', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const body = JSON.stringify({key: 'value'});
	const size = Buffer.byteLength(body);
	const events: Progress[] = [];

	await got.post({body}).on('uploadProgress', (event: Progress) => events.push(event));

	checkEvents(t, events, size);
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

	t.is(events[0]?.total, undefined);
	checkEvents(t, events);
});

test('upload progress - no body', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	await got.post('').on('uploadProgress', (event: Progress) => events.push(event));

	t.deepEqual(events, [
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

test('upload progress - no events when immediatly removed listener', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const listener = (event: Progress) => events.push(event);

	const promise = got.post('')
		.on('uploadProgress', listener)
		.off('uploadProgress', listener);

	await promise;

	t.is(events.length, 0);
});

test('upload progress - one event when removed listener', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const promise = got.post('');

	const listener = (event: Progress) => {
		events.push(event);
		void promise.off('uploadProgress', listener);
	};

	void promise.on('uploadProgress', listener);

	await promise;

	t.deepEqual(events, [
		{
			percent: 0,
			transferred: 0,
			total: undefined,
		},
	]);
});

test('does not emit uploadProgress after cancelation', withServer, async (t, server, got) => {
	server.post('/', () => {});

	const stream = got.stream.post();

	stream.once('uploadProgress', () => { // 0%
		stream.once('uploadProgress', () => { // 'foo'
			stream.write('bar');

			process.nextTick(() => {
				process.nextTick(() => {
					stream.on('uploadProgress', () => {
						t.fail('Emitted uploadProgress after cancelation');
					});

					stream.destroy();
				});
			});
		});
	});

	stream.write('foo');

	await pEvent(stream, 'close');

	t.pass();
});
