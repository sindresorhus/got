import test from 'ava';
import toReadableStream from 'to-readable-stream';
import getStream from 'get-stream';
import pEvent from 'p-event';
import delay from 'delay';
import is from '@sindresorhus/is';
import withServer from './helpers/with-server';

const defaultHandler = (_request, response) => {
	response.writeHead(200, {
		unicorn: 'rainbow',
		'content-encoding': 'gzip'
	});
	response.end(Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64')); // 'ok'
};

const redirectHandler = (_request, response) => {
	response.writeHead(302, {
		location: '/'
	});
	response.end();
};

const postHandler = (request, response) => {
	request.pipe(response);
};

const errorHandler = (_request, response) => {
	response.statusCode = 404;
	response.end();
};

test('`options.responseType` is ignored', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.notThrowsAsync(getStream(got.stream({responseType: 'json'})));
});

test('returns readable stream', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const data = await getStream(got.stream(''));
	t.is(data, 'ok');
});

test('returns writeable stream', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post('');
	const promise = getStream(stream);
	stream.end('wow');

	t.is(await promise, 'wow');
});

test('throws on write if body is specified', withServer, (t, server, got) => {
	server.post('/', postHandler);

	t.throws(() => {
		got.stream.post({body: 'wow'}).end('wow');
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
	server.get('/', errorHandler);

	const stream = got.stream('');
	await t.throwsAsync(pEvent(stream, 'response'), {
		instanceOf: got.HTTPError,
		message: 'Response code 404 (Not Found)'
	});
});

test('has error event #2', withServer, async (t, _server, got) => {
	const stream = got.stream('http://doesntexist');
	await t.throwsAsync(pEvent(stream, 'response'), {code: 'ENOTFOUND'});
});

test('has response event if `options.throwHttpErrors` is false', withServer, async (t, server, got) => {
	server.get('/', errorHandler);

	const {statusCode} = await pEvent(got.stream({throwHttpErrors: false}), 'response');
	t.is(statusCode, 404);
});

test('accepts `options.body` as a Stream', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({body: toReadableStream('wow')});
	t.is(await getStream(stream), 'wow');
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
	t.true(is.function_(stream.on('foobar', () => {}).pipe));

	stream.destroy();
});

test('piping works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is(await getStream(got.stream('')), 'ok');
	t.is(await getStream(got.stream('').on('foobar', () => {})), 'ok');
});

test('proxying headers works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', (_request, response) => {
		got.stream('').pipe(response);
	});

	const {headers, body} = await got('proxy');
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], undefined);
	t.is(body, 'ok');
});

test('skips proxying headers after server has sent them already', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', (_request, response) => {
		response.writeHead(200);
		got.stream('').pipe(response);
	});

	const {headers} = await got('proxy');
	t.is(headers.unicorn, undefined);
});

test('throws when trying to proxy through a closed stream', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		const stream = got.stream('');
		await delay(1000);
		t.throws(() => stream.pipe(response), 'Failed to pipe. The response has been emitted already.');
		response.end();
	});

	await got('proxy');
});

test('proxies `content-encoding` header when `options.decompress` is false', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', (_request, response) => {
		got.stream({decompress: false}).pipe(response);
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

// Do not remove this. Some test is throwing a unhandled rejection and we need to know what particular test does that.
// (It will log the test name in Got options)
process.on('unhandledRejection', console.log);
