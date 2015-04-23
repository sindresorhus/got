'use strict';
var zlib = require('zlib');
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();
var testContent = 'Compressible response content.\n';

s.on('/', function (req, res) {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Encoding', 'gzip');
	zlib.gzip(testContent, function (err, data) {
		res.end(data);
	});
});

s.on('/corrupted', function (req, res) {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Encoding', 'gzip');
	res.end('Not gzipped content');
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('ungzip content', function (t) {
	got(s.url, function (err, data) {
		t.error(err);
		t.equal(data, testContent);
		t.end();
	});
});

tape('ungzip error', function (t) {
	got(s.url + '/corrupted', function (err) {
		t.ok(err);
		t.equal(err.message, 'Reading ' + s.url + '/corrupted response failed');
		t.end();
	});
});

tape('preserve headers property', function (t) {
	got(s.url, function (err, data, res) {
		t.error(err);
		t.ok(res.headers);
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
