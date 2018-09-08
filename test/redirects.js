import {URL} from 'url';
import test from 'ava';
import got from '../source';
import {createServer, createSSLServer} from './helpers/server';

let http;
let https;

test.before('setup', async () => {
	const reached = (request, response) => {
		response.end('reached');
	};
	https = await createSSLServer();
	http = await createServer();

	// HTTPS Handlers

	https.on('/', (request, response) => {
		response.end('https');
	});

	https.on('/httpsToHttp', (request, response) => {
		response.writeHead(302, {
			location: http.url
		});
		response.end();
	});

	// HTTP Handlers

	http.on('/', reached);

	http.on('/finite', (request, response) => {
		response.writeHead(302, {
			location: `${http.url}/`
		});
		response.end();
	});

	http.on('/utf8-url-áé', reached);
	http.on('/?test=it’s+ok', reached);

	http.on('/redirect-with-utf8-binary', (request, response) => {
		response.writeHead(302, {
			location: Buffer.from((new URL('/utf8-url-áé', http.url)).toString(), 'utf8').toString('binary')
		});
		response.end();
	});

	http.on('/redirect-with-uri-encoded-location', (request, response) => {
		response.writeHead(302, {
			location: new URL('/?test=it’s+ok', http.url).toString()
		});
		response.end();
	});

	http.on('/endless', (request, response) => {
		response.writeHead(302, {
			location: `${http.url}/endless`
		});
		response.end();
	});

	http.on('/relative', (request, response) => {
		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	http.on('/seeOther', (request, response) => {
		response.writeHead(303, {
			location: '/'
		});
		response.end();
	});

	http.on('/temporary', (request, response) => {
		response.writeHead(307, {
			location: '/'
		});
		response.end();
	});

	http.on('/permanent', (request, response) => {
		response.writeHead(308, {
			location: '/'
		});
		response.end();
	});

	http.on('/relativeQuery?bang', (request, response) => {
		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	http.on('/httpToHttps', (request, response) => {
		response.writeHead(302, {
			location: https.url
		});
		response.end();
	});

	http.on('/malformedRedirect', (request, response) => {
		response.writeHead(302, {
			location: '/%D8'
		});
		response.end();
	});

	http.on('/invalidRedirect', (request, response) => {
		response.writeHead(302, {
			location: 'http://'
		});
		response.end();
	});

	await http.listen(http.port);
	await https.listen(https.port);
});

test.after('cleanup', async () => {
	await http.close();
	await https.close();
});

test('follows redirect', async t => {
	const {body, redirectUrls} = await got(`${http.url}/finite`);
	t.is(body, 'reached');
	t.deepEqual(redirectUrls, [`${http.url}/`]);
});

test('follows 307, 308 redirect', async t => {
	const tempBody = (await got(`${http.url}/temporary`)).body;
	t.is(tempBody, 'reached');

	const permBody = (await got(`${http.url}/permanent`)).body;
	t.is(permBody, 'reached');
});

test('does not follow redirect when disabled', async t => {
	t.is((await got(`${http.url}/finite`, {followRedirect: false})).statusCode, 302);
});

test('relative redirect works', async t => {
	t.is((await got(`${http.url}/relative`)).body, 'reached');
});

test('throws on endless redirect', async t => {
	const error = await t.throwsAsync(got(`${http.url}/endless`));
	t.is(error.message, 'Redirected 10 times. Aborting.');
	t.deepEqual(error.redirectUrls, new Array(10).fill(`${http.url}/endless`));
});

test('query in options are not breaking redirects', async t => {
	t.is((await got(`${http.url}/relativeQuery`, {query: 'bang'})).body, 'reached');
});

test('hostname+path in options are not breaking redirects', async t => {
	t.is((await got(`${http.url}/relative`, {
		hostname: http.host,
		path: '/relative'
	})).body, 'reached');
});

test('redirect only GET and HEAD requests', async t => {
	const error = await t.throwsAsync(got(`${http.url}/relative`, {body: 'wow'}));
	t.is(error.message, 'Response code 302 (Found)');
	t.is(error.path, '/relative');
	t.is(error.statusCode, 302);
});

test('redirect on 303 response even with post, put, delete', async t => {
	const {url, body} = await got(`${http.url}/seeOther`, {body: 'wow'});
	t.is(url, `${http.url}/`);
	t.is(body, 'reached');
});

test('redirects from http to https works', async t => {
	t.truthy((await got(`${http.url}/httpToHttps`, {rejectUnauthorized: false})).body);
});

test('redirects from https to http works', async t => {
	t.truthy((await got(`${https.url}/httpsToHttp`, {rejectUnauthorized: false})).body);
});

test('redirects works with lowercase method', async t => {
	const {body} = (await got(`${http.url}/relative`, {method: 'head'}));
	t.is(body, '');
});

test('redirect response contains new url', async t => {
	const {url} = (await got(`${http.url}/finite`));
	t.is(url, `${http.url}/`);
});

test('redirect response contains old url', async t => {
	const {requestUrl} = (await got(`${http.url}/finite`));
	t.is(requestUrl, `${http.url}/finite`);
});

test('redirect response contains UTF-8 with binary encoding', async t => {
	t.is((await got(`${http.url}/redirect-with-utf8-binary`)).body, 'reached');
});

test('redirect response contains UTF-8 with URI encoding', async t => {
	t.is((await got(`${http.url}/redirect-with-uri-encoded-location`)).body, 'reached');
});

test('throws on malformed redirect URI', async t => {
	const error = await t.throwsAsync(got(`${http.url}/malformedRedirect`));
	t.is(error.name, 'URIError');
});

test('throws on invalid redirect URL', async t => {
	const error = await t.throwsAsync(got(`${http.url}/invalidRedirect`));
	t.is(error.code, 'ERR_INVALID_URL');
});
