import test from 'ava';
import toReadableStream from 'to-readable-stream';
import getStream from 'get-stream';
import pEvent from 'p-event';
import delay from 'delay';
import is from '@sindresorhus/is';
import withServer from './helpers/with-server';

const defaultHandler = (request, response) => {
	response.writeHead(200, {
		unicorn: 'rainbow',
		'content-encoding': 'gzip'
	});
	response.end(Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64')); // 'ok'
};

const redirectHandler = (request, response) => {
	response.writeHead(302, {
		location: '/'
	});
	response.end();
};

const postHandler = (request, response) => {
	request.pipe(response);
};

const errorHandler = (request, response) => {
	response.statusCode = 404;
	response.end();
};

test('options.responseType is ignored', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.notThrowsAsync(() => getStream(got.stream({responseType: 'json'})));
});

test('returns readable stream', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const data = await getStream(got.stream(''));
	t.is(data.toString(), 'ok');
});

test('returns writeable stream', withServer, async (t, server, got) => {
	server.post('/post', postHandler);

	const stream = got.stream.post('post');
	const promise = getStream(stream);
	stream.end('wow');
	t.is((await promise).toString(), 'wow');
});

test('throws on write to stream with body specified', withServer, (t, server, got) => {
	server.post('/post', postHandler);

	t.throws(() => {
		got.stream.post('post', {body: 'wow'}).end('wow');
	}, 'Got\'s stream is not writable when the `body` option is used');
});

test('has request event', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	const request = await pEvent(stream, 'request');
	t.truthy(request);
	// @ts-ignore
	t.is(request.method, 'GET');

	await getStream(stream);
});

test('has redirect event', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const stream = got.stream('redirect');
	const {headers} = await pEvent(stream, 'redirect');
	t.is(headers.location, '/');

	await getStream(stream);
});

test('has response event', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const {statusCode} = await pEvent(got.stream(''), 'response');
	t.is(statusCode, 200);
});

test('has error event', withServer, async (t, server, got) => {
	server.get('/error', errorHandler);

	const stream = got.stream('error');
	await t.throwsAsync(pEvent(stream, 'response'), /Response code 404 \(Not Found\)/);
});

test('has error event #2', withServer, async (t, server, got) => {
	const stream = got.stream('http://doesntexist');
	await t.throwsAsync(pEvent(stream, 'response'), /getaddrinfo ENOTFOUND/);
});

test('has response event on throwHttpErrors === false', withServer, async (t, server, got) => {
	server.get('/error', errorHandler);

	const {statusCode} = await pEvent(got.stream('error', {throwHttpErrors: false}), 'response');
	t.is(statusCode, 404);
});

test('accepts option.body as Stream', withServer, async (t, server, got) => {
	server.post('/post', postHandler);

	const stream = got.stream.post('post', {body: toReadableStream('wow')});
	const data = await pEvent(stream, 'data');
	t.is(data.toString(), 'wow');
});

test('redirect response contains old url', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const {requestUrl} = await pEvent(got.stream('redirect'), 'response');
	t.is(requestUrl, `${server.url}/redirect`);
});

test('check for pipe method', withServer, (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	t.true(is.function_(stream.pipe));
	t.true(is.function_(stream.on('error', () => {}).pipe));
});

test('piping works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is(await getStream(got.stream('')), 'ok');
	t.is(await getStream(got.stream('').on('error', () => {})), 'ok');
});

test('proxying headers works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', (request, response) => {
		got.stream('').pipe(response);
	});

	const {headers, body} = await got('proxy');
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], undefined);
	t.is(body, 'ok');
});

test('skips proxying headers after server has sent them already', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', (request, response) => {
		response.writeHead(200);
		got.stream('').pipe(response);
	});

	const {headers} = await got('proxy');
	t.is(headers.unicorn, undefined);
});

test('throws when trying to proxy through a closed stream', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (request, response) => {
		const stream = got.stream('');
		await delay(1000);
		t.throws(() => stream.pipe(response));
		response.end();
	});

	await got('proxy');
});

test('proxies content-encoding header when options.decompress is false', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', (request, response) => {
		got.stream('', {decompress: false}).pipe(response);
	});

	const {headers} = await got('proxy');
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], 'gzip');
});

test('destroying got.stream() cancels the request', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	const request = await pEvent(stream, 'request');
	stream.destroy();
	// @ts-ignore
	t.truthy(request.aborted);
});

test('piping to got.stream.put()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.put('/post', postHandler);

	await t.notThrowsAsync(async () => {
		await getStream(got.stream('').pipe(got.stream.put('post')));
	});
});
