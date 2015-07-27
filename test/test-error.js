'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.statusCode = 404;
	res.end('not');
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('error message', function (t) {
	got(s.url, function (err) {
		t.ok(err);
		t.equal(err.message, 'Response code 404 (Not Found)');
		t.equal(err.host, 'localhost:6767');
		t.equal(err.method, 'GET');
		t.end();
	});
});

test('dns error message', function (t) {
	got('.com', function (err) {
		t.ok(err);
		t.ok(/getaddrinfo ENOTFOUND/.test(err.message));
		t.equal(err.host, '.com');
		t.equal(err.method, 'GET');
		t.end();
	});
});

test('options.body error message', function (t) {
	t.throws(function () {
		got(s.url, {body: function () {}});
	}, /options.body must be a ReadableStream, string, Buffer or plain Object/);
	t.end();
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
