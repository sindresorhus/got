'use strict';
var test = require('ava');
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

test.before('redirects - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('redirects - follows redirect', function (t) {
	got(s.url + '/finite', function (err, data) {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - follows relative redirect', function (t) {
	got(s.url + '/relative', function (err, data) {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - throws on endless redirect', function (t) {
	got(s.url + '/endless', function (err) {
		t.ok(err, 'should get error');
		t.is(err.message, 'Redirected 10 times. Aborting.');
		t.end();
	});
});

test('redirects - query in options are not breaking redirects', function (t) {
	got(s.url + '/relativeQuery', {query: 'bang'}, function (err, data) {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - hostname+path in options are not breaking redirects', function (t) {
	got(s.url + '/relative', {hostname: s.host, path: '/relative'}, function (err, data) {
		t.ifError(err);
		t.is(data, 'reached');
		t.end();
	});
});

test('redirects - redirect only GET and HEAD requests', function (t) {
	got(s.url + '/relative', {body: 'wow'}, function (err) {
		t.is(err.message, 'Response code 302 (Moved Temporarily)');
		t.is(err.path, '/relative');
		t.is(err.statusCode, 302);
		t.end();
	});
});

test.after('redirect - cleanup', function (t) {
	s.close();
	t.end();
});
