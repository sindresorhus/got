import {TLSSocket} from 'tls';
import test from 'ava';
import {Handler} from 'express';
import nock = require('nock');
import {MaxRedirectsError} from '../source';
import withServer from './helpers/with-server';

const reachedHandler: Handler = (_request, response) => {
	const body = 'reached';

	response.writeHead(200, {
		'content-length': body.length
	});
	response.end(body);
};

const finiteHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/'
	});
	response.end();
};

const relativeHandler: Handler = (_request, response) => {
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

	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/'
		});
		response.end();
	});

	server.get('/permanent', (_request, response) => {
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
	server.get('/', finiteHandler);

	t.is((await got({followRedirect: false})).statusCode, 302);
});

test('relative redirect works', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	t.is((await got('relative')).body, 'reached');
});

test('throws on endless redirects - default behavior', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got(''), 'Redirected 10 times. Aborting.');

	t.deepEqual(error.response.redirectUrls, new Array(10).fill(`${server.url}/`));
});

test('custom `maxRedirects` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got('', {maxRedirects: 5}), 'Redirected 5 times. Aborting.');

	t.deepEqual(error.response.redirectUrls, new Array(5).fill(`${server.url}/`));
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

test('hostname + pathname are not breaking redirects', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	t.is((await got('relative', {
		hostname: server.hostname,
		pathname: '/relative'
	})).body, 'reached');
});

test('redirects GET and HEAD requests', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(308, {
			location: '/'
		});
		response.end();
	});

	await t.throwsAsync(got.get(''), {
		instanceOf: got.MaxRedirectsError
	});
});

test('redirects POST requests', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(308, {
			location: '/'
		});
		response.end();
	});

	await t.throwsAsync(got.post({body: 'wow'}), {
		instanceOf: got.MaxRedirectsError
	});
});

test('redirects on 303 if GET or HEAD', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.head('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/'
		});
		response.end();
	});

	const {url, headers, request} = await got.head('seeOther');
	t.is(url, `${server.url}/`);
	t.is(headers['content-length'], 'reached'.length.toString());
	t.is(request.options.method, 'HEAD');
});

test('redirects on 303 response even on post, put, delete', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.post('/seeOther', (_request, response) => {
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

	server.get('/httpToHttps', (_request, response) => {
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

	server.get('/httpsToHttp', (_request, response) => {
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

	server.get('/redirect-with-utf8-binary', (_request, response) => {
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

	server.get('/redirect-with-uri-encoded-location', (_request, response) => {
		response.writeHead(302, {
			location: new URL('/?test=it’s+ok', server.url).toString()
		});
		response.end();
	});

	t.is((await got('redirect-with-uri-encoded-location')).body, 'reached');
});

test('throws on malformed redirect URI', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: '/%D8'
		});
		response.end();
	});

	await t.throwsAsync(got(''), {
		name: 'URIError'
	});
});

test('throws on invalid redirect URL', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'http://'
		});
		response.end();
	});

	await t.throwsAsync(got(''), {
		code: 'ERR_INVALID_URL'
	});
});

test('port is reset on redirect', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(307, {
			location: 'http://localhost'
		});
		response.end();
	});

	nock('http://localhost').get('/').reply(200, 'ok');

	const {body} = await got('');
	t.is(body, 'ok');
});

test('body is reset on GET redirect', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(303, {
			location: '/'
		});
		response.end();
	});

	server.get('/', (_request, response) => {
		response.end();
	});

	await got.post('', {
		body: 'foobar',
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				}
			]
		}
	});
});

test('body is passed on POST redirect', withServer, async (t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const {body} = await got.post('redirect', {
		body: 'foobar',
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, 'foobar');
				}
			]
		}
	});

	t.is(body, 'foobar');
});

test('method overwriting can be turned off', withServer, async (t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	server.get('/', (_request, response) => {
		response.end();
	});

	const {body} = await got.post('redirect', {
		body: 'foobar',
		methodRewriting: false,
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				}
			]
		}
	});

	t.is(body, '');
});
