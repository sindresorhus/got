'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('reached');
});

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

test('hostname+path in options are not breaking redirects', function (t) {
	got(s.url + '/relative', {hostname: s.host, path: '/relative'}, function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

test('redirect only GET and HEAD requests', function (t) {
	got(s.url + '/relative', {body: 'wow'}, function (err) {
		t.equal(err.message, 'Response code 302 (Moved Temporarily)');
		t.equal(err.path, '/relative');
		t.equal(err.statusCode, 302);
		t.end();
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
