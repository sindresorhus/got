import test from 'ava';
import toReadableStream from 'to-readable-stream';
import getStream from 'get-stream';
import pEvent from 'p-event';
import is from '@sindresorhus/is';
import got from '..';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/post', (req, res) => {
		req.pipe(res);
	});

	s.on('/redirect', (req, res) => {
		res.writeHead(302, {
			location: s.url
		});
		res.end();
	});

	s.on('/error', (req, res) => {
		res.statusCode = 404;
		res.end();
	});

	await s.listen(s.port);
});

test('option.json can not be used', t => {
	t.throws(() => {
		got.stream(s.url, {json: true});
	}, 'Got can not be used as a stream when the `json` option is used');
});

test('returns readable stream', async t => {
	const data = await pEvent(got.stream(s.url), 'data');
	t.is(data.toString(), 'ok');
});

test('returns writeable stream', async t => {
	const stream = got.stream.post(`${s.url}/post`);
	const promise = pEvent(stream, 'data');
	stream.end('wow');
	t.is((await promise).toString(), 'wow');
});

test('throws on write to stream with body specified', t => {
	t.throws(() => {
		got.stream(s.url, {body: 'wow'}).end('wow');
	}, 'Got\'s stream is not writable when the `body` option is used');
});

test('have request event', async t => {
	const request = await pEvent(got.stream(s.url), 'request');
	t.truthy(request);
	t.is(request.method, 'GET');
});

test('have redirect event', async t => {
	const response = await pEvent(got.stream(`${s.url}/redirect`), 'redirect');
	t.is(response.headers.location, s.url);
});

test('have response event', async t => {
	const response = await pEvent(got.stream(s.url), 'response');
	t.is(response.statusCode, 200);
});

test('have error event', async t => {
	const stream = got.stream(`${s.url}/error`, {retries: 0});
	await t.throws(pEvent(stream, 'response'), /Response code 404 \(Not Found\)/);
});

test('have error event #2', async t => {
	const stream = got.stream('.com', {retries: 0});
	await t.throws(pEvent(stream, 'response'), /getaddrinfo ENOTFOUND/);
});

test('have response event on throwHttpErrors === false', async t => {
	const response = await pEvent(got.stream(`${s.url}/error`, {throwHttpErrors: false}), 'response');
	t.is(response.statusCode, 404);
});

test('accepts option.body as Stream', async t => {
	const stream = got.stream(`${s.url}/post`, {body: toReadableStream('wow')});
	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'wow');
});

test('redirect response contains old url', async t => {
	const response = await pEvent(got.stream(`${s.url}/redirect`), 'response');
	t.is(response.requestUrl, `${s.url}/redirect`);
});

test('check for pipe method', t => {
	const stream = got.stream(`${s.url}/`);
	t.true(is.function(stream.pipe));
	t.true(is.function(stream.on('error', () => {}).pipe));
});

test('piping works', async t => {
	t.is(await getStream(got.stream(`${s.url}/`)), 'ok');
	t.is(await getStream(got.stream(`${s.url}/`).on('error', () => {})), 'ok');
});

test.after('cleanup', async () => {
	await s.close();
});
