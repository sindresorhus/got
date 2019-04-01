import {TLSSocket} from 'tls';
import {URL} from 'url';
import test from 'ava';
import nock from 'nock';
import withServer from './helpers/with-server';

const reachedHandler = (request, response) => {
	response.end('reached');
};

const finiteHandler = (request, response) => {
	response.writeHead(302, {
		location: '/'
	});
	response.end();
};

const relativeHandler = (request, response) => {
	response.writeHead(302, {
		location: '/'
	});
	response.end();
};

test('follows redirect', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite');
	t.is(body, 'reached');
	t.deepEqual(redirectUrls, [`${server.url}/`]);
});

test('follows 307, 308 redirect', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/temporary', (request, response) => {
		response.writeHead(307, {
			location: '/'
		});
		response.end();
	});

	server.get('/permanent', (request, response) => {
		response.writeHead(308, {
			location: '/'
		});
		response.end();
	});

	const tempBody = (await got('temporary')).body;
	t.is(tempBody, 'reached');

	const permBody = (await got('permanent')).body;
	t.is(permBody, 'reached');
});

test('does not follow redirect when disabled', withServer, async (t, server, got) => {
	server.get('/finite', finiteHandler);

	t.is((await got('finite', {followRedirect: false})).statusCode, 302);
});

test('relative redirect works', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	t.is((await got('relative')).body, 'reached');
});

test('throws on endless redirects', withServer, async (t, server, got) => {
	server.get('/endless', (request, response) => {
		response.writeHead(302, {
			location: `${server.url}/endless`
		});
		response.end();
	});

	const error = await t.throwsAsync(() => got('endless'), 'Redirected 10 times. Aborting.');

	// @ts-ignore
	t.deepEqual(error.redirectUrls, new Array(10).fill(`${server.url}/endless`));
});

test('searchParams are not breaking redirects', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/relativeSearchParam', (request, response) => {
		t.is(request.query.bang, '1');

		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	t.is((await got('relativeSearchParam', {searchParams: 'bang=1'})).body, 'reached');
});

test('hostname + path are not breaking redirects', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	t.is((await got('relative', {
		hostname: server.hostname,
		path: '/relative'
	})).body, 'reached');
});

test('redirects only GET and HEAD requests', withServer, async (t, server, got) => {
	server.post('/relative', relativeHandler);

	const error = await t.throwsAsync(() => got.post('relative', {body: 'wow'}), {
		instanceOf: got.HTTPError,
		message: 'Response code 302 (Found)'
	});

	// @ts-ignore
	t.is(error.path, '/relative');
	// @ts-ignore
	t.is(error.statusCode, 302);
});

test('redirects on 303 response even on post, put, delete', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.post('/seeOther', (request, response) => {
		response.writeHead(303, {
			location: '/'
		});
		response.end();
	});

	const {url, body} = await got.post('seeOther', {body: 'wow'});
	t.is(url, `${server.url}/`);
	t.is(body, 'reached');
});

test('redirects from http to https work', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.socket instanceof TLSSocket) {
			response.end('https');
		} else {
			response.end('http');
		}
	});

	server.get('/httpToHttps', (request, response) => {
		response.writeHead(302, {
			location: server.sslUrl
		});
		response.end();
	});

	t.is((await got('httpToHttps', {rejectUnauthorized: false})).body, 'https');
});

test('redirects from https to http work', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.socket instanceof TLSSocket) {
			response.end('https');
		} else {
			response.end('http');
		}
	});

	server.get('/httpsToHttp', (request, response) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	t.truthy((await got.secure('httpsToHttp', {rejectUnauthorized: false})).body);
});

test('redirects works with lowercase method', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	const {body} = await got('relative', {method: 'head'});
	t.is(body, '');
});

test('redirect response contains new url', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {url} = await got('finite');
	t.is(url, `${server.url}/`);
});

test('redirect response contains old url', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {requestUrl} = await got('finite');
	t.is(requestUrl, `${server.url}/finite`);
});

test('redirect response contains UTF-8 with binary encoding', withServer, async (t, server, got) => {
	server.get('/utf8-url-%C3%A1%C3%A9', reachedHandler);

	server.get('/redirect-with-utf8-binary', (request, response) => {
		response.writeHead(302, {
			location: Buffer.from((new URL('/utf8-url-áé', server.url)).toString(), 'utf8').toString('binary')
		});
		response.end();
	});

	t.is((await got('redirect-with-utf8-binary')).body, 'reached');
});

test('redirect response contains UTF-8 with URI encoding', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		t.is(request.query.test, 'it’s ok');
		response.end('reached');
	});

	server.get('/redirect-with-uri-encoded-location', (request, response) => {
		response.writeHead(302, {
			location: new URL('/?test=it’s+ok', server.url).toString()
		});
		response.end();
	});

	t.is((await got('redirect-with-uri-encoded-location')).body, 'reached');
});

test('throws on malformed redirect URI', withServer, async (t, server, got) => {
	server.get('/malformedRedirect', (request, response) => {
		response.writeHead(302, {
			location: '/%D8'
		});
		response.end();
	});

	await t.throwsAsync(() => got('malformedRedirect'), {
		name: 'URIError'
	});
});

test('throws on invalid redirect URL', withServer, async (t, server, got) => {
	server.get('/invalidRedirect', (request, response) => {
		response.writeHead(302, {
			location: 'http://'
		});
		response.end();
	});

	await t.throwsAsync(() => got('invalidRedirect'), {
		code: 'ERR_INVALID_URL'
	});
});

test('port is reset on redirect', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.writeHead(307, {
			location: 'http://localhost'
		});
		response.end();
	});

	nock('http://localhost').get('/').reply(200, 'ok');

	const {body} = await got('');
	t.is(body, 'ok');
});
