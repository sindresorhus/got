import test from 'ava';
import toReadableStream from 'to-readable-stream';
import getStream from 'get-stream';
import pEvent from 'p-event';
import delay from 'delay';
import is from '@sindresorhus/is';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.writeHead(200, {
			unicorn: 'rainbow',
			'content-encoding': 'gzip'
		});
		response.end(Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64')); // 'ok'
	});

	s.on('/post', (request, response) => {
		request.pipe(response);
	});

	s.on('/redirect', (request, response) => {
		response.writeHead(302, {
			location: s.url
		});
		response.end();
	});

	s.on('/error', (request, response) => {
		response.statusCode = 404;
		response.end();
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('options.responseType is ignored', t => {
	t.notThrows(() => got.stream(s.url, {responseType: 'json'}));
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
	// @ts-ignore
	t.is(request.method, 'GET');
});

test('have redirect event', async t => {
	const {headers} = await pEvent(got.stream(`${s.url}/redirect`), 'redirect');
	t.is(headers.location, s.url);
});

test('have response event', async t => {
	const {statusCode} = await pEvent(got.stream(s.url), 'response');
	t.is(statusCode, 200);
});

test('have error event', async t => {
	const stream = got.stream(`${s.url}/error`, {retry: 0});
	await t.throwsAsync(pEvent(stream, 'response'), /Response code 404 \(Not Found\)/);
});

test('have error event #2', async t => {
	const stream = got.stream('http://doesntexist', {retry: 0});
	await t.throwsAsync(pEvent(stream, 'response'), /getaddrinfo ENOTFOUND/);
});

test('have response event on throwHttpErrors === false', async t => {
	const {statusCode} = await pEvent(got.stream(`${s.url}/error`, {throwHttpErrors: false}), 'response');
	t.is(statusCode, 404);
});

test('accepts option.body as Stream', async t => {
	const stream = got.stream(`${s.url}/post`, {body: toReadableStream('wow')});
	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'wow');
});

test('redirect response contains old url', async t => {
	const {requestUrl} = await pEvent(got.stream(`${s.url}/redirect`), 'response');
	t.is(requestUrl, `${s.url}/redirect`);
});

test('check for pipe method', t => {
	const stream = got.stream(`${s.url}/`);
	t.true(is.function_(stream.pipe));
	t.true(is.function_(stream.on('error', () => {}).pipe));
});

test('piping works', async t => {
	t.is(await getStream(got.stream(`${s.url}/`)), 'ok');
	t.is(await getStream(got.stream(`${s.url}/`).on('error', () => {})), 'ok');
});

test('proxying headers works', async t => {
	const server = await createServer();

	server.on('/', (request, response) => {
		got.stream(s.url).pipe(response);
	});

	await server.listen(server.port);

	const {headers, body} = await got(server.url);
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], undefined);
	t.is(body, 'ok');

	await server.close();
});

test('skips proxying headers after server has sent them already', async t => {
	const server = await createServer();

	server.on('/', (request, response) => {
		response.writeHead(200);
		got.stream(s.url).pipe(response);
	});

	await server.listen(server.port);

	const {headers} = await got(server.url);
	t.is(headers.unicorn, undefined);

	await server.close();
});

test('throws when trying to proxy through a closed stream', async t => {
	const server = await createServer();

	server.on('/', async (request, response) => {
		const stream = got.stream(s.url);
		await delay(1000);
		t.throws(() => stream.pipe(response));
		response.end();
	});

	await server.listen(server.port);
	await got(server.url);
	await server.close();
});

test('proxies content-encoding header when options.decompress is false', async t => {
	const server = await createServer();

	server.on('/', (request, response) => {
		got.stream(s.url, {decompress: false}).pipe(response);
	});

	await server.listen(server.port);

	const {headers} = await got(server.url);
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], 'gzip');

	await server.close();
});

test('destroying got.stream() cancels the request', async t => {
	const stream = got.stream(s.url);
	const request = await pEvent(stream, 'request');
	stream.destroy();
	// @ts-ignore
	t.truthy(request.aborted);
});

test('piping to got.stream.put()', async t => {
	await t.notThrowsAsync(async () => {
		await getStream(got.stream(s.url).pipe(got.stream.put(`${s.url}/post`)));
	});
});
