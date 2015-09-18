import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

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

test.before('redirects - setup', t => {
	s.listen(s.port, () => t.end());
});

test('redirects - follows redirect', t => {
	got(`${s.url}/finite`, (err, data) => {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - follows relative redirect', t => {
	got(`${s.url}/relative`, (err, data) => {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - throws on endless redirect', t => {
	got(`${s.url}/endless`, err => {
		t.ok(err, 'should get error');
		t.is(err.message, 'Redirected 10 times. Aborting.');
		t.end();
	});
});

test('redirects - query in options are not breaking redirects', t => {
	got(`${s.url}/relativeQuery`, {query: 'bang'}, (err, data) => {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - hostname+path in options are not breaking redirects', t => {
	got(`${s.url}/relative`, {
		hostname: s.host,
		path: '/relative'
	}, (err, data) => {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - redirect only GET and HEAD requests', t => {
	got(`${s.url}/relative`, {body: 'wow'}, err => {
		t.is(err.message, 'Response code 302 (Moved Temporarily)');
		t.is(err.path, '/relative');
		t.is(err.statusCode, 302);
		t.end();
	});
});

test.after('redirect - cleanup', t => {
	s.close();
	t.end();
});
