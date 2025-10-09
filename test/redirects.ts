import {Buffer} from 'node:buffer';
import test from 'ava';
import type {Handler} from 'express';
import nock from 'nock';
import got, {MaxRedirectsError, RequestError} from '../source/index.js';
import withServer, {withHttpsServer} from './helpers/with-server.js';

const reachedHandler: Handler = (_request, response) => {
	const body = 'reached';

	response.writeHead(200, {
		'content-length': body.length,
	});
	response.end(body);
};

const finiteHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/',
	});
	response.end();
};

const relativeHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/',
	});
	response.end();
};

const unixProtocol: Handler = (_request, response) => {
	response.writeHead(302, {
		location: 'unix:/var/run/docker.sock:/containers/json',
	});
	response.end();
};

const unixHostname: Handler = (_request, response) => {
	response.writeHead(302, {
		location: 'http://unix:/var/run/docker.sock:/containers/json',
	});
	response.end();
};

test('cannot redirect to UNIX protocol when UNIX sockets are enabled', withServer, async (t, server, got) => {
	server.get('/protocol', unixProtocol);
	server.get('/hostname', unixHostname);

	const gotUnixSocketsEnabled = got.extend({enableUnixSockets: true});

	t.true(gotUnixSocketsEnabled.defaults.options.enableUnixSockets);

	await t.throwsAsync(gotUnixSocketsEnabled('protocol'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});

	await t.throwsAsync(gotUnixSocketsEnabled('hostname'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});
});

test('cannot redirect to UNIX protocol when UNIX sockets are not enabled', withServer, async (t, server, got) => {
	server.get('/protocol', unixProtocol);
	server.get('/hostname', unixHostname);

	const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

	t.false(gotUnixSocketsDisabled.defaults.options.enableUnixSockets);

	await t.throwsAsync(gotUnixSocketsDisabled('protocol'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});

	await t.throwsAsync(gotUnixSocketsDisabled('hostname'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});
});

test('follows redirect', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite');
	t.is(body, 'reached');
	t.deepEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('does not follow redirect when followRedirect is a function and returns false', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, statusCode} = await got('finite', {followRedirect: () => false});
	t.not(body, 'reached');
	t.is(statusCode, 302);
});

test('follows redirect when followRedirect is a function and returns true', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite', {followRedirect: () => true});
	t.is(body, 'reached');
	t.deepEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('followRedirect gets plainResponse and does not follow', withServer, async (t, server, got) => {
	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/redirect',
		});
		response.end();
	});

	const {statusCode} = await got('temporary', {
		followRedirect(response) {
			t.is(response.headers.location, '/redirect');
			return false;
		},
	});
	t.is(statusCode, 307);
});

test('follows 307, 308 redirect', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/',
		});
		response.end();
	});

	server.get('/permanent', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});

	const temporaryBody = (await got('temporary')).body;
	t.is(temporaryBody, 'reached');

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
			location: server.url,
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got(''), {message: 'Redirected 10 times. Aborting.'});

	t.deepEqual(error?.response.redirectUrls.map(String), Array.from({length: 10}).fill(`${server.url}/`));
	t.is(error?.code, 'ERR_TOO_MANY_REDIRECTS');
});

test('custom `maxRedirects` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url,
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got('', {maxRedirects: 5}), {message: 'Redirected 5 times. Aborting.'});

	t.deepEqual(error?.response.redirectUrls.map(String), Array.from({length: 5}).fill(`${server.url}/`));
	t.is(error?.code, 'ERR_TOO_MANY_REDIRECTS');
});

test('searchParams are not breaking redirects', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/relativeSearchParam', (request, response) => {
		t.is(request.query.bang, '1');

		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	t.is((await got('relativeSearchParam', {searchParams: 'bang=1'})).body, 'reached');
});

test('redirects GET and HEAD requests', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});

	await t.throwsAsync(got.get(''), {
		instanceOf: MaxRedirectsError,
		code: 'ERR_TOO_MANY_REDIRECTS',
	});
});

test('redirects POST requests', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});

	await t.throwsAsync(got.post({body: 'wow'}), {
		instanceOf: MaxRedirectsError,
		code: 'ERR_TOO_MANY_REDIRECTS',
	});
});

test('redirects on 303 if GET or HEAD', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.head('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {url, headers, request} = await got.head('seeOther');
	t.is(url, `${server.url}/`);
	t.is(headers['content-length'], 'reached'.length.toString());
	t.is(request.options.method, 'HEAD');
});

test('removes body on GET redirect', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		request.pipe(response);
	});

	server.post('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {headers, body} = await got.post('seeOther', {body: 'hello'});
	t.is(body, '');
	t.is(headers['content-length'], '0');
});

test('redirects on 303 response even on post, put, delete', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.post('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {url, body} = await got.post('seeOther', {body: 'wow'});
	t.is(url, `${server.url}/`);
	t.is(body, 'reached');
});

test('redirects from http to https work', withServer, async (t, serverHttp) => {
	await withHttpsServer().exec(t, async (t, serverHttps, got) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttp.get('/httpToHttps', (_request, response) => {
			response.writeHead(302, {
				location: serverHttps.url,
			});
			response.end();
		});

		t.is((await got('httpToHttps', {
			prefixUrl: serverHttp.url,
		})).body, 'https');
	});
});

test('redirects from https to http work', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer.exec(t, async (t, serverHttp) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttps.get('/httpsToHttp', (_request, response) => {
			response.writeHead(302, {
				location: serverHttp.url,
			});
			response.end();
		});

		t.is((await got('httpsToHttp', {
			prefixUrl: serverHttps.url,
		})).body, 'http');
	});
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
	t.is(requestUrl.toString(), `${server.url}/finite`);
});

test('redirect response contains UTF-8 with binary encoding', withServer, async (t, server, got) => {
	server.get('/utf8-url-%C3%A1%C3%A9', reachedHandler);

	server.get('/redirect-with-utf8-binary', (_request, response) => {
		response.writeHead(302, {
			location: Buffer.from((new URL('/utf8-url-áé', server.url)).toString(), 'utf8').toString('binary'),
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
			location: new URL('/?test=it’s+ok', server.url).toString(),
		});
		response.end();
	});

	t.is((await got('redirect-with-uri-encoded-location')).body, 'reached');
});

test('throws on invalid redirect URL', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'http://',
		});
		response.end();
	});

	await t.throwsAsync(got(''), {
		code: 'ERR_INVALID_URL',
	});
});

test('port is reset on redirect', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(307, {
			location: 'http://localhost',
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
			location: '/',
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
				},
			],
		},
	});

	await got.post('', {
		json: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				},
			],
		},
	});

	await got.post('', {
		form: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				},
			],
		},
	});
});

test('body is passed on POST redirect', withServer, async (t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
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
				},
			],
		},
	});

	t.is(body, 'foobar');
});

test('method rewriting', withServer, async (t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});
	server.get('/', (_request, response) => {
		response.end();
	});

	server.post('/temporaryRedirect', (_request, response) => {
		response.writeHead(307, {
			location: '/',
		});
		response.end();
	});
	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const {body} = await got.post('redirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				},
			],
		},
	});

	t.is(body, '');

	// Do not rewrite method on 307 or 308
	const {body: temporaryRedirectBody} = await got.post('temporaryRedirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, 'foobar');
				},
			],
		},
	});

	t.is(temporaryRedirectBody, 'foobar');
});

test('clears username and password when redirecting to a different hostname', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'https://example.com/',
		});
		response.end();
	});

	nock('https://example.com').get('/').reply(200, function () {
		return JSON.stringify({headers: this.req.headers});
	});

	const {headers} = await got('', {
		username: 'hello',
		password: 'world',
	}).json<{headers: Record<string, string | undefined>}>();
	t.is(headers.authorization, undefined);
});

test('clears the authorization header when redirecting to a different hostname', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'https://example.com/',
		});
		response.end();
	});

	nock('https://example.com').get('/').reply(200, function () {
		return JSON.stringify({headers: this.req.headers});
	});

	const {headers} = await got('', {
		headers: {
			authorization: 'Basic aGVsbG86d29ybGQ=',
		},
	}).json<{headers: Record<string, string | undefined>}>();
	t.is(headers.authorization, undefined);
});

test('preserves userinfo on redirect to the same origin', withServer, async (t, server) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(303, {
			location: `http://localhost:${server.port}/`,
		});
		response.end();
	});

	server.get('/', (request, response) => {
		t.is(request.headers.authorization, 'Basic aGVsbG86d29ybGQ=');
		response.end();
	});

	await got(`http://hello:world@localhost:${server.port}/redirect`);
});

test('clears the host header when redirecting to a different hostname', async t => {
	nock('https://testweb.com').get('/redirect').reply(302, undefined, {location: 'https://webtest.com/'});
	nock('https://webtest.com').get('/').reply(function (_uri, _body) {
		return [200, this.req.getHeader('host')];
	});

	const resp = await got('https://testweb.com/redirect', {headers: {host: 'wrongsite.com'}});
	t.is(resp.body, 'webtest.com');
});

test('correct port on redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
		server1.get('/redirect', (_request, response) => {
			response.redirect(`http://${server2.hostname}:${server2.port}/`);
		});

		server1.get('/', (_request, response) => {
			response.end('SERVER1');
		});

		server2.get('/', (_request, response) => {
			response.end('SERVER2');
		});

		const response = await got(`${server1.url}/redirect`, {prefixUrl: ''});

		t.is(response.body, 'SERVER2');
	});
});

test('downloadProgress does not fire for redirect responses', withServer, async (t, server, got) => {
	const body = Buffer.alloc(1024);

	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': body.length,
		});
		response.end(body);
	});

	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
			'content-length': '0',
		});
		response.end();
	});

	const progressEvents: Array<{transferred: number; total?: number}> = [];

	await got('redirect', {responseType: 'buffer'})
		.on('downloadProgress', event => {
			progressEvents.push({transferred: event.transferred, total: event.total});
		});

	// Should have at least 2 events: initial and final
	// All events should be for the final response (total = 1024), not the redirect
	t.true(progressEvents.length >= 2);

	// First event should be initial progress for final response
	t.is(progressEvents[0]?.transferred, 0);
	t.is(progressEvents[0]?.total, 1024);

	// Last event should be completion
	const lastEvent = progressEvents.at(-1)!;
	t.is(lastEvent.transferred, 1024);
	t.is(lastEvent.total, 1024);

	// All events should have total = 1024 (the final response size, not 0 from redirect)
	for (const event of progressEvents) {
		t.is(event.total, 1024);
	}
});
