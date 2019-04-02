import is from '@sindresorhus/is';
import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';

test('simple request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.is((await got('')).body, 'ok');
});

test('empty response', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	t.is((await got('')).body, '');
});

test('response has `requestUrl` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/empty', (_request, response) => {
		response.end();
	});

	t.is((await got('')).requestUrl, `${server.url}/`);
	t.is((await got('empty')).requestUrl, `${server.url}/empty`);
});

test('errors have `statusCode` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync(got(''), got.HTTPError);
	t.is(error.statusCode, 404);
	t.is(error.response.body, 'not');
});

test('status code 304 doesn\'t throw', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 304;
		response.end();
	});

	const promise = got('');
	await t.notThrowsAsync(promise);
	const {statusCode, body} = await promise;
	t.is(statusCode, 304);
	t.is(body, '');
});

test('doesn\'t throw if `options.throwHttpErrors` is false', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	t.is((await got({throwHttpErrors: false})).body, 'not');
});

test('invalid protocol throws', async t => {
	await t.throwsAsync(got('c:/nope.com').json(), {
		instanceOf: got.UnsupportedProtocolError,
		message: 'Unsupported protocol "c:"'
	});
});

test('gives buffer if `options.encoding` is null', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const data = (await got({encoding: null})).body;
	t.true(is.buffer(data));
});

test('`searchParams` option', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		t.is(request.query.recent, 'true');
		response.end('recent');
	});

	t.is((await got({searchParams: {recent: true}})).body, 'recent');
	t.is((await got({searchParams: 'recent=true'})).body, 'recent');
});

test('response has `requestUrl` property even if `url` is an object', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.is((await got({hostname: server.hostname, port: server.port})).requestUrl, `${server.url}/`);
	t.is((await got({hostname: server.hostname, port: server.port, protocol: 'http:'})).requestUrl, `${server.url}/`);
});

test('response contains url', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.is((await got('')).url, `${server.url}/`);
});

test('response contains got options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const options = {
		auth: 'foo:bar'
	};

	t.is((await got(options)).request.gotOptions.auth, options.auth);
});
