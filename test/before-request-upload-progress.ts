import {Buffer} from 'node:buffer';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import type {Handler} from 'express';
import type {NormalizedOptions, Progress} from '../source/index.js';
import withServer from './helpers/with-server.js';

const echoHandler: Handler = async (request, response) => {
	const chunks = await request.toArray();
	response.end(Buffer.concat(chunks).toString());
};

for (const body of ['a replacement body', 'x', '', '你好 👋', 'x'.repeat(200_000)]) {
	for (const useStream of [false, true]) {
		test(`upload progress uses the ${Buffer.byteLength(body)}-byte replacement body in ${useStream ? 'stream' : 'promise'} mode`, withServer, async (t, server, got) => {
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

			t.is(responseBody, body);
			t.true(events.length >= 2);
			for (const event of events) {
				t.is(event.total, Buffer.byteLength(body));
				t.is(event.percent, body.length === 0 ? 1 : event.transferred / Buffer.byteLength(body));
			}

			t.deepEqual(events.at(-1), {percent: 1, transferred: Buffer.byteLength(body), total: Buffer.byteLength(body)});
		});
	}
}

for (const removeLength of [false, true]) {
	test(`upload progress clears stale size when a hook ${removeLength ? 'removes content-length' : 'sets transfer-encoding'}`, withServer, async (t, server, got) => {
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

		t.is(response.body, 'a streamed replacement');
		t.true(events.length >= 2);
		t.is(events[0]!.total, undefined);
		t.is(events[0]!.percent, 0);
		t.deepEqual(events.at(-1), {percent: 1, transferred: Buffer.byteLength(body), total: Buffer.byteLength(body)});
	});
}
