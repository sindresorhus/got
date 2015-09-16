'use strict';
var tempfile = require('tempfile');
var format = require('util').format;
var test = require('ava');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

var socketPath = tempfile('.socket');

s.on('/', function (req, res) {
	res.end('ok');
});

test.before('unix-socket - setup', function (t) {
	s.listen(socketPath, function () {
		t.end();
	});
});

test('unix-socket - request via unix socket', function (t) {
	// borrow unix domain socket url format from request module
	var url = format('http://unix:%s:%s', socketPath, '/');

	got(url, function (err, data) {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('unix-socket - protocol-less request', function (t) {
	var url = format('unix:%s:%s', socketPath, '/');

	got(url, function (err, data) {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test.after('unix-socket - cleanup', function (t) {
	s.close();
	t.end();
});
