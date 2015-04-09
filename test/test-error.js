'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.statusCode = 404;
	res.end('not');
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('error message', function (t) {
	got(s.url, function (err) {
		t.ok(err);
		t.equal(err.message, 'http://localhost:6767 response code is 404 (Not Found)');
		t.end();
	});
});

tape('dns error message', function (t) {
	got('.com', function (err) {
		t.ok(err);
		t.equal(err.message, 'Request to .com failed');
		t.ok(err.nested);
		t.equal(err.nested.message, 'getaddrinfo ENOTFOUND');
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
