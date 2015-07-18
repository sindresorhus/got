'use strict';
var zlib = require('zlib');
var test = require('tap').test;
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

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('ungzip content', function (t) {
	got(s.url, function (err, data) {
		t.error(err);
		t.equal(data, testContent);
		t.end();
	});
});

test('ungzip error', function (t) {
	got(s.url + '/corrupted', function (err) {
		t.ok(err);
		t.equal(err.message, 'incorrect header check');
		t.equal(err.path, '/corrupted');
		t.equal(err.name, 'ReadError');
		t.end();
	});
});

test('preserve headers property', function (t) {
	got(s.url, function (err, data, res) {
		t.error(err);
		t.ok(res.headers);
		t.end();
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
