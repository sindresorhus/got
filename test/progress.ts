import {promisify} from 'util';
import stream = require('stream');
import fs = require('fs');
import SlowStream = require('slow-stream');
import toReadableStream = require('to-readable-stream');
import getStream = require('get-stream');
import FormData = require('form-data');
import tempy = require('tempy');
import is from '@sindresorhus/is';
import test, {Macro} from 'ava';
import {Handler} from 'express';
import {Progress} from '../source';
import withServer from './helpers/with-server';

const checkEvents: Macro<[Progress[], number?]> = (t, events, bodySize = undefined) => {
	t.true(events.length >= 2);

	let lastEvent = events.shift()!;

	if (!is.number(bodySize)) {
		t.is(lastEvent.percent, 0);
	}

	for (const [index, event] of events.entries()) {
		if (is.number(bodySize)) {
			t.is(event.percent, event.transferred / bodySize);
			t.true(event.percent > lastEvent.percent);
		} else {
			const isLastEvent = index === events.length - 1;
			t.is(event.percent, isLastEvent ? 1 : 0);
		}

		t.true(event.transferred >= lastEvent.transferred);
		t.is(event.total, bodySize);

		lastEvent = event;
	}
};

const file = Buffer.alloc(1024 * 1024 * 2);

const downloadEndpoint: Handler = (_request, response) => {
	response.setHeader('content-length', file.length);

	stream.pipeline(
		toReadableStream(file),
		new SlowStream({maxWriteInterval: 50}),
		response,
		() => {
			response.end();
		}
	);
};

const noTotalEndpoint: Handler = (_request, response) => {
	response.write('hello');
	response.end();
};

const uploadEndpoint: Handler = (request, response) => {
	stream.pipeline(
		request,
		new SlowStream({maxWriteInterval: 100}),
		() => {
			response.end();
		}
	);
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

	const path = tempy.file();
	fs.writeFileSync(path, file);

	const events: Progress[] = [];

	await got.post({body: fs.createReadStream(path)})
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
		headers: {'content-length': file.length.toString()}
	};

	const request = got.stream.post(options)
		.on('uploadProgress', event => events.push(event));

	await getStream(
		stream.pipeline(toReadableStream(file), request, () => {})
	);

	checkEvents(t, events, file.length);
});

test('upload progress - stream with unknown body size', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const request = got.stream.post('')
		.on('uploadProgress', event => events.push(event));

	await getStream(
		stream.pipeline(toReadableStream(file), request, () => {})
	);

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
			total: 0
		},
		{
			percent: 1,
			transferred: 0,
			total: 0
		}
	]);
});
