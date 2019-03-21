import is from '@sindresorhus/is';
import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';

test('simple request', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});
	t.is((await got(s.url)).body, 'ok');
});

test('empty response', withServer, async (t, s) => {
	s.get('/empty', (request, response) => {
		response.end();
	});
	t.is((await got(`${s.url}/empty`)).body, '');
});

test('requestUrl response', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});
	s.get('/empty', (request, response) => {
		response.end();
	});
	t.is((await got(s.url)).requestUrl, `${s.url}/`);
	t.is((await got(`${s.url}/empty`)).requestUrl, `${s.url}/empty`);
});

test('error with code', withServer, async (t, s) => {
	s.get('/404', (request, response) => {
		response.statusCode = 404;
		response.end('not');
	});
	const error = await t.throwsAsync(got(`${s.url}/404`));
	t.is(error.statusCode, 404);
	t.is(error.response.body, 'not');
});

test('status code 304 doesn\'t throw', withServer, async (t, s) => {
	s.get('/304', (request, response) => {
		response.statusCode = 304;
		response.end();
	});
	const promise = got(`${s.url}/304`);
	await t.notThrowsAsync(promise);
	const {statusCode, body} = await promise;
	t.is(statusCode, 304);
	t.is(body, '');
});

test('doesn\'t throw on throwHttpErrors === false', withServer, async (t, s) => {
	s.get('/404', (request, response) => {
		response.statusCode = 404;
		response.end('not');
	});
	t.is((await got(`${s.url}/404`, {throwHttpErrors: false})).body, 'not');
});

test('invalid protocol throws', async t => {
	const error = await t.throwsAsync(got('c:/nope.com').json());
	t.is(error.constructor, got.UnsupportedProtocolError);
});

test('buffer on encoding === null', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});
	const data = (await got(s.url, {encoding: null})).body;
	t.true(is.buffer(data));
});

test('searchParams option', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('recent');
	});
	s.get('/?recent=true', (request, response) => {
		response.end('recent');
	});
	t.is((await got(s.url, {searchParams: {recent: true}})).body, 'recent');
	t.is((await got(s.url, {searchParams: 'recent=true'})).body, 'recent');
});

test('requestUrl response when sending url as param', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});
	t.is((await got(s.url, {hostname: s.hostname, port: s.port})).requestUrl, `${s.url}/`);
	t.is((await got({hostname: s.hostname, port: s.port, protocol: 'http:'})).requestUrl, `${s.url}/`);
});

test('response contains url', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});
	t.is((await got(s.url)).url, `${s.url}/`);
});

test('response contains got options', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});

	const options = {
		url: s.url,
		auth: 'foo:bar'
	};

	t.is((await got(options)).request.gotOptions.auth, options.auth);
});
