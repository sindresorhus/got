'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/finite', function (req, res) {
	res.writeHead(302, {
		location: s.url + '/'
	});
	res.end();
});

s.on('/endless', function (req, res) {
	res.writeHead(302, {
		location: s.url + '/endless'
	});
	res.end();
});

s.on('/relative', function (req, res) {
	res.writeHead(302, {
		location: '/'
	});
	res.end();
});

s.on('/relativeQuery?bang', function (req, res) {
	res.writeHead(302, {
		location: '/'
	});
	res.end();
});

s.on('/', function (req, res) {
	res.end('reached');
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('follows redirect', function (t) {
	got(s.url + '/finite', function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

test('follows relative redirect', function (t) {
	got(s.url + '/relative', function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

test('throws on endless redirect', function (t) {
	got(s.url + '/endless', function (err) {
		t.ok(err, 'should get error');
		t.equal(err.message, 'Redirected 10 times. Aborting.');
		t.end();
	});
});

test('query in options are not breaking redirects', function (t) {
	got(s.url + '/relativeQuery', {query: 'bang'}, function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

test('host+path in options are not breaking redirects', function (t) {
	got(s.url + '/relative', {host: s.url, path: '/relative'}, function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

test('redirect only GET and HEAD requests', function (t) {
	got(s.url + '/relative', {body: 'wow'}, function (err) {
		t.equal(err.message, 'POST http://localhost:6767/relative response code is 302 (Found)');
		t.equal(err.code, 302);
		t.end();
	});
});

test('redirect event', function (t) {
	got(s.url + '/endless')
		.on('redirect', function (res, opts) {
			t.equal(res.headers.location, s.url + '/endless');
			opts.path = '/';
		})
		.on('data', function (data) {
			t.equal(data.toString(), 'reached');
			t.end();
		});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
