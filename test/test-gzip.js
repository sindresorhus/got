'use strict';
var zlib = require('zlib');
var test = require('ava');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();
var testContent = 'Compressible response content.\n';

s.on('/', function (req, res) {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Encoding', 'gzip');
	zlib.gzip(testContent, function (_, data) {
		res.end(data);
	});
});

s.on('/corrupted', function (req, res) {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Encoding', 'gzip');
	res.end('Not gzipped content');
});

test.before('gzip - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('gzip - ungzip content', function (t) {
	got(s.url, function (err, data) {
		t.ifError(err);
		t.is(data, testContent);
		t.end();
	});
});

test('gzip - ungzip error', function (t) {
	got(s.url + '/corrupted', function (err) {
		t.ok(err);
		t.is(err.message, 'incorrect header check');
		t.is(err.path, '/corrupted');
		t.is(err.name, 'ReadError');
		t.end();
	});
});

test('gzip - preserve headers property', function (t) {
	got(s.url, function (err, data, res) {
		t.ifError(err);
		t.ok(res.headers);
		t.end();
	});
});

test.after('gzip - cleanup', function (t) {
	s.close();
	t.end();
});
