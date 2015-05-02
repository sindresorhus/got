'use strict';
var tape = require('tape');
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

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('follows redirect', function (t) {
	got(s.url + '/finite', function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

tape('follows relative redirect', function (t) {
	got(s.url + '/relative', function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

tape('throws on endless redirect', function (t) {
	got(s.url + '/endless', function (err) {
		t.ok(err, 'should get error');
		t.equal(err.message, 'Redirected 10 times. Aborting.');
		t.end();
	});
});

tape('query in options are not breaking redirects', function (t) {
	got(s.url + '/relativeQuery', {query: 'bang'}, function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

tape('host+path in options are not breaking redirects', function (t) {
	got(s.url + '/relative', {host: s.url, path: '/relative'}, function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

tape('redirect only GET and HEAD requests', function (t) {
	got(s.url + '/relative', {body: 'wow'}, function (err, data) {
		t.equal(err.message, 'POST http://localhost:6767/relative response code is 302 (Found)');
		t.equal(err.code, 302);
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
