import {Buffer} from 'buffer';
import stream from 'stream';
// @ts-expect-error Fails to find slow-stream/index.d.ts
import SlowStream from 'slow-stream';
import toReadableStream from 'to-readable-stream';
import getStream from 'get-stream';
import is from '@sindresorhus/is';
import test, {ExecutionContext} from 'ava';
import {Handler} from 'express';
import {Progress} from '../source/index.js';
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

const uploadEndpoint: Handler = (request, response) => {
	stream.pipeline(
		request,
		new SlowStream({maxWriteInterval: 100}),
		() => {
			response.end();
		},
	);
};

test('upload progress - stream with unknown body size', withServer, async (t, server, got) => {
	server.post('/', uploadEndpoint);

	const events: Progress[] = [];

	const request = got.stream.post('')
		.on('uploadProgress', event => events.push(event));

	await getStream(
		stream.pipeline(toReadableStream(file), request, () => {}),
	);

	t.is(events[0]?.total, undefined);
	checkEvents(t, events);
});
