import test from 'ava';
import got from '../';
import {createServer} from './_server';

let s;

test.before('setup', async t => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('reached');
	});

	s.on('/finite', (req, res) => {
		res.writeHead(302, {
			location: `${s.url}/`
		});
		res.end();
	});

	s.on('/endless', (req, res) => {
		res.writeHead(302, {
			location: `${s.url}/endless`
		});
		res.end();
	});

	s.on('/relative', (req, res) => {
		res.writeHead(302, {
			location: '/'
		});
		res.end();
	});

	s.on('/relativeQuery?bang', (req, res) => {
		res.writeHead(302, {
			location: '/'
		});
		res.end();
	});

	await s.listen(s.port);
});

test('follows redirect', async t => {
	t.is((await got(`${s.url}/finite`)).body, 'reached');
});

test('relative redirect works', async t => {
	t.is((await got(`${s.url}/relative`)).body, 'reached');
});

test('throws on endless redirect', async t => {
	try {
		await got(`${s.url}/endless`);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.message, 'Redirected 10 times. Aborting.');
	}
});

test('query in options are not breaking redirects', async t => {
	t.is((await got(`${s.url}/relativeQuery`, {query: 'bang'})).body, 'reached');
});

test('hostname+path in options are not breaking redirects', async t => {
	t.is((await got(`${s.url}/relative`, {hostname: s.host, path: '/relative'})).body, 'reached');
});

test('redirect only GET and HEAD requests', async t => {
	try {
		await got(`${s.url}/relative`, {body: 'wow'});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.message, 'Response code 302 (Moved Temporarily)');
		t.is(err.path, '/relative');
		t.is(err.statusCode, 302);
	}
});

test.after('cleanup', async t => {
	await s.close();
});
