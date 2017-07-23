import fs from 'fs';
import SlowStream from 'slow-stream';
import intoStream from 'into-stream';
import getStream from 'get-stream';
import FormData from 'form-data';
import tempfile from 'tempfile';
import pify from 'pify';
import test from 'ava';
import got from '..';
import {createServer} from './helpers/server';

const checkEvents = (t, events, bodySize = null) => {
	t.true(events.length >= 2);

	const hasBodySize = typeof bodySize === 'number';
	let lastEvent = events.shift();

	if (!hasBodySize) {
		t.is(lastEvent.percent, 0);
	}

	for (const [index, event] of events.entries()) {
		if (hasBodySize) {
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
let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/download', (req, res) => {
		res.setHeader('content-length', file.length);

		intoStream(file)
			.pipe(new SlowStream({maxWriteInterval: 50}))
			.pipe(res);
	});

	s.on('/download/no-total', (req, res) => {
		res.write('hello');
		res.end();
	});

	s.on('/upload', (req, res) => {
		req
			.pipe(new SlowStream({maxWriteInterval: 100}))
			.on('end', () => res.end());
	});

	await s.listen(s.port);
});

test('download progress', async t => {
	const events = [];

	const res = await got(`${s.url}/download`, {encoding: null})
		.on('downloadProgress', e => events.push(e));

	checkEvents(t, events, res.body.length);
});

test('download progress - missing total size', async t => {
	const events = [];

	await got(`${s.url}/download/no-total`)
		.on('downloadProgress', e => events.push(e));

	checkEvents(t, events);
});

test('download progress - stream', async t => {
	const events = [];

	const stream = got.stream(`${s.url}/download`, {encoding: null})
		.on('downloadProgress', e => events.push(e));

	await getStream(stream);

	checkEvents(t, events, file.length);
});

test('upload progress - file', async t => {
	const events = [];

	await got.post(`${s.url}/upload`, {body: file})
		.on('uploadProgress', e => events.push(e));

	checkEvents(t, events, file.length);
});

test('upload progress - file stream', async t => {
	const path = tempfile();
	fs.writeFileSync(path, file);

	const events = [];

	await got.post(`${s.url}/upload`, {body: fs.createReadStream(path)})
		.on('uploadProgress', e => events.push(e));

	checkEvents(t, events, file.length);
});

test('upload progress - form data', async t => {
	const events = [];

	const body = new FormData();
	body.append('key', 'value');
	body.append('file', file);

	const size = await pify(body.getLength.bind(body))();

	await got.post(`${s.url}/upload`, {body})
		.on('uploadProgress', e => events.push(e));

	checkEvents(t, events, size);
});

test('upload progress - json', async t => {
	const body = JSON.stringify({key: 'value'});
	const size = Buffer.byteLength(body);
	const events = [];

	await got.post(`${s.url}/upload`, {body})
		.on('uploadProgress', e => events.push(e));

	checkEvents(t, events, size);
});

test('upload progress - stream with known body size', async t => {
	const events = [];
	const options = {
		headers: {'content-length': file.length}
	};

	const req = got.stream.post(`${s.url}/upload`, options)
		.on('uploadProgress', e => events.push(e));

	await getStream(intoStream(file).pipe(req));

	checkEvents(t, events, file.length);
});

test('upload progress - stream with unknown body size', async t => {
	const events = [];

	const req = got.stream.post(`${s.url}/upload`)
		.on('uploadProgress', e => events.push(e));

	await getStream(intoStream(file).pipe(req));

	checkEvents(t, events);
});

test('upload progress - no body', async t => {
	const events = [];

	await got.post(`${s.url}/upload`)
		.on('uploadProgress', e => events.push(e));

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

test.after('cleanup', async () => {
	await s.close();
});
