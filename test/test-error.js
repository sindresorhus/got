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
		t.equal(err.message, 'GET http://localhost:6767 response code is 404 (Not Found)');
		t.end();
	});
});

test('dns error message', function (t) {
	got('.com', function (err) {
		t.ok(err);
		t.equal(err.message, 'Request to http://.com failed');
		t.ok(err.nested);
		t.ok(/getaddrinfo ENOTFOUND/.test(err.nested.message));
		t.end();
	});
});

test('options.body error message', function (t) {
	t.throws(function () {
		got(s.url, {body: {}});
	}, /options.body must be a ReadableStream, string or Buffer/);
	t.end();
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
