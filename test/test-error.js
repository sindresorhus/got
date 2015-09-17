'use strict';
var test = require('ava');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.statusCode = 404;
	res.end('not');
});

test.before('error - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('error - error message', function (t) {
	got(s.url, function (err) {
		t.ok(err);
		t.is(err.message, 'Response code 404 (Not Found)');
		t.is(err.host, s.host + ':' + s.port);
		t.is(err.method, 'GET');
		t.end();
	});
});

test('error - dns error message', function (t) {
	got('.com', function (err) {
		t.ok(err);
		t.regexTest(/getaddrinfo ENOTFOUND/, err.message);
		t.is(err.host, '.com');
		t.is(err.method, 'GET');
		t.end();
	});
});

test('error - options.body error message', function (t) {
	t.plan(2);
	t.throws(function () {
		got(s.url, {body: function () {}}, function () {});
	}, /options.body must be a ReadableStream, string, Buffer or plain Object/);

	got(s.url, {body: function () {}})
		.catch(function (err) {
			t.regexTest(/options.body must be a ReadableStream, string, Buffer or plain Object/, err.message);
		});
});

test.after('error - cleanup', function (t) {
	s.close();
	t.end();
});
