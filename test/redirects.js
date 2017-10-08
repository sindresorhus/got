import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/', (req, res) => {
		if (req.secure) {
			res.end('https');
		}
		res.end('reached');
	});

	s.get('/finite', (req, res) => {
		res.writeHead(302, {
			location: `${s.url}/`
		});
		res.end();
	});

	s.get('/utf8-url-áé', (req, res) => {
		res.end('reached');
	});

	s.get('/redirect-with-utf8-binary', (req, res) => {
		res.writeHead(302, {
			location: Buffer.from(`${s.url}/utf8-url-áé`, 'utf8').toString('binary')
		});
		res.end();
	});

	s.get('/endless', (req, res) => {
		res.writeHead(302, {
			location: `${s.url}/endless`
		});
		res.end();
	});

	s.all('/relative', (req, res) => {
		res.writeHead(302, {
			location: '/'
		});
		res.end();
	});

	s.all('/seeOther', (req, res) => {
		res.writeHead(303, {
			location: '/'
		});
		res.end();
	});

	s.get('/temporary', (req, res) => {
		res.writeHead(307, {
			location: '/'
		});
		res.end();
	});

	s.get('/permanent', (req, res) => {
		res.writeHead(308, {
			location: '/'
		});
		res.end();
	});

	s.get('/relativeQuery', (req, res) => {
		res.writeHead(302, {
			location: '/'
		});
		res.end();
	});

	s.get('/httpToHttps', (req, res) => {
		res.writeHead(302, {
			location: s.sslUrl
		});
		res.end();
	});
});

test('follows redirect', async t => {
	const {body, redirectUrls} = await got(`${s.url}/finite`);
	t.is(body, 'reached');
	t.deepEqual(redirectUrls, [`${s.url}/`]);
});

test('follows 307, 308 redirect', async t => {
	const tempBody = (await got(`${s.url}/temporary`)).body;
	t.is(tempBody, 'reached');

	const permBody = (await got(`${s.url}/permanent`)).body;
	t.is(permBody, 'reached');
});

test('does not follow redirect when disabled', async t => {
	t.is((await got(`${s.url}/finite`, {followRedirect: false})).statusCode, 302);
});

test('relative redirect works', async t => {
	t.is((await got(`${s.url}/relative`)).body, 'reached');
});

test('throws on endless redirect', async t => {
	const err = await t.throws(got(`${s.url}/endless`));
	t.is(err.message, 'Redirected 10 times. Aborting.');
	t.deepEqual(err.redirectUrls, Array(10).fill(`${s.url}/endless`));
});

test('query in options are not breaking redirects', async t => {
	t.is((await got(`${s.url}/relativeQuery`, {query: 'bang'})).body, 'reached');
});

test('hostname+path in options are not breaking redirects', async t => {
	t.is((await got(`${s.url}/relative`, {
		hostname: 'localhost',
		path: '/relative'
	})).body, 'reached');
});

test('redirect only GET and HEAD requests', async t => {
	const err = await t.throws(got(`${s.url}/relative`, {body: 'wow'}));
	t.is(err.message, 'Response code 302 (Found)');
	t.is(err.path, '/relative');
	t.is(err.statusCode, 302);
});

test('redirect on 303 response even with post, put, delete', async t => {
	const {url, body} = await got(`${s.url}/seeOther`, {body: 'wow'});
	t.is(url, `${s.url}/`);
	t.is(body, 'reached');
});

test('redirects from http to https works', async t => {
	const body = (await got(`${s.url}/httpToHttps`, {rejectUnauthorized: false})).body;
	t.is(body, 'https');
});

test('redirects works with lowercase method', async t => {
	const body = (await got(`${s.url}/relative`, {method: 'head'})).body;
	t.is(body, '');
});

test('redirect response contains new url', async t => {
	const url = (await got(`${s.url}/finite`)).url;
	t.is(url, `${s.url}/`);
});

test('redirect response contains old url', async t => {
	const requestUrl = (await got(`${s.url}/finite`)).requestUrl;
	t.is(requestUrl, `${s.url}/finite`);
});

test('redirect response contains utf8 with binary encoding', async t => {
	t.is((await got(`${s.url}/redirect-with-utf8-binary`)).body, 'reached');
});

test.after('cleanup', async () => {
	await s.close();
});
