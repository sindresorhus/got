import test from 'ava';
import {Handler} from 'express';
import nock = require('nock');
import got, {MaxRedirectsError} from '../source';
import {withHttpServer, withHttpsServer} from './helpers/with-server';

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

test('follows redirect', withHttpServer(), async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite');
	t.is(body, 'reached');
	t.deepEqual(redirectUrls, [`${server.url}/`]);
});

test('follows 307, 308 redirect', withHttpServer(), async (t, server, got) => {
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

	const temporaryBody = (await got('temporary')).body;
	t.is(temporaryBody, 'reached');

	const permBody = (await got('permanent')).body;
	t.is(permBody, 'reached');
});

test('does not follow redirect when disabled', withHttpServer(), async (t, server, got) => {
	server.get('/', finiteHandler);

	t.is((await got({followRedirect: false})).statusCode, 302);
});

test('relative redirect works', withHttpServer(), async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	t.is((await got('relative')).body, 'reached');
});

test('throws on endless redirects - default behavior', withHttpServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got(''), {message: 'Redirected 10 times. Aborting.'});

	t.deepEqual(error.response.redirectUrls, new Array(10).fill(`${server.url}/`));
});

test('custom `maxRedirects` option', withHttpServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got('', {maxRedirects: 5}), {message: 'Redirected 5 times. Aborting.'});

	t.deepEqual(error.response.redirectUrls, new Array(5).fill(`${server.url}/`));
});

test('searchParams are not breaking redirects', withHttpServer(), async (t, server, got) => {
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

test('redirects GET and HEAD requests', withHttpServer(), async (t, server, got) => {
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

test('redirects POST requests', withHttpServer(), async (t, server, got) => {
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

test('redirects on 303 if GET or HEAD', withHttpServer(), async (t, server, got) => {
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

test('redirects on 303 response even on post, put, delete', withHttpServer(), async (t, server, got) => {
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

test('redirects from http to https work', withHttpServer(), async (t, serverHttp) => {
	await withHttpsServer()(t, async (t, serverHttps, got) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttp.get('/httpToHttps', (_request, response) => {
			response.writeHead(302, {
				location: serverHttps.url
			});
			response.end();
		});

		t.is((await got('httpToHttps', {
			prefixUrl: serverHttp.url
		})).body, 'https');
	});
});

test('redirects from https to http work', withHttpsServer(), async (t, serverHttps, got) => {
	await withHttpServer()(t, async (t, serverHttp) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttps.get('/httpsToHttp', (_request, response) => {
			response.writeHead(302, {
				location: serverHttp.url
			});
			response.end();
		});

		t.is((await got('httpsToHttp', {
			prefixUrl: serverHttps.url
		})).body, 'http');
	});
});

test('redirects works with lowercase method', withHttpServer(), async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	const {body} = await got('relative', {method: 'head'});
	t.is(body, '');
});

test('redirect response contains new url', withHttpServer(), async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {url} = await got('finite');
	t.is(url, `${server.url}/`);
});

test('redirect response contains old url', withHttpServer(), async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {requestUrl} = await got('finite');
	t.is(requestUrl, `${server.url}/finite`);
});

test('redirect response contains UTF-8 with binary encoding', withHttpServer(), async (t, server, got) => {
	server.get('/utf8-url-%C3%A1%C3%A9', reachedHandler);

	server.get('/redirect-with-utf8-binary', (_request, response) => {
		response.writeHead(302, {
			location: Buffer.from((new URL('/utf8-url-áé', server.url)).toString(), 'utf8').toString('binary')
		});
		response.end();
	});

	t.is((await got('redirect-with-utf8-binary')).body, 'reached');
});

test('redirect response contains UTF-8 with URI encoding', withHttpServer(), async (t, server, got) => {
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

test('throws on malformed redirect URI', withHttpServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: '/%D8'
		});
		response.end();
	});

	await t.throwsAsync(got(''), {
		message: 'URI malformed'
	});
});

test('throws on invalid redirect URL', withHttpServer(), async (t, server, got) => {
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

test('port is reset on redirect', withHttpServer(), async (t, server, got) => {
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

test('body is reset on GET redirect', withHttpServer(), async (t, server, got) => {
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

	await got.post('', {
		json: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				}
			]
		}
	});

	await got.post('', {
		form: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				}
			]
		}
	});
});

test('body is passed on POST redirect', withHttpServer(), async (t, server, got) => {
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

test('method rewriting can be turned off', withHttpServer(), async (t, server, got) => {
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

test('clears username and password when redirecting to a different hostname', withHttpServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'https://httpbin.org/anything'
		});
		response.end();
	});

	const {headers} = await got('', {
		username: 'hello',
		password: 'world'
	}).json();
	t.is(headers.Authorization, undefined);
});

test('clears the authorization header when redirecting to a different hostname', withHttpServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'https://httpbin.org/anything'
		});
		response.end();
	});

	const {headers} = await got('', {
		headers: {
			authorization: 'Basic aGVsbG86d29ybGQ='
		}
	}).json();
	t.is(headers.Authorization, undefined);
});

test('clears the host header when redirecting to a different hostname', async t => {
	nock('https://testweb.com').get('/redirect').reply(302, undefined, {location: 'https://webtest.com/'});
	nock('https://webtest.com').get('/').reply(function (_uri, _body) {
		return [200, this.req.getHeader('host')];
	});

	const resp = await got('https://testweb.com/redirect', {headers: {host: 'wrongsite.com'}});
	t.is(resp.body, 'webtest.com');
});

test('correct port on redirect', withHttpServer(), async (t, server1, got) => {
	await withHttpServer()(t, async (t, server2) => {
		server1.get('/redirect', (_request, response) => {
			response.redirect(`http://${server2.hostname}:${server2.port}/`);
		});

		server1.get('/', (_request, response) => {
			response.end('SERVER1');
		});

		server2.get('/', (_request, response) => {
			response.end('SERVER2');
		});

		const response = await got({
			protocol: 'http:',
			hostname: server1.hostname,
			port: server1.port,
			pathname: '/redirect'
		});

		t.is(response.body, 'SERVER2');
	});
});
