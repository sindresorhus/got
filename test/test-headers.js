'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end(JSON.stringify(req.headers));
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('send user-agent header by default', function (t) {
	got(s.url, function (err, data) {
		t.error(err);

		var headers = JSON.parse(data);

		t.equal(headers['user-agent'], 'https://github.com/sindresorhus/got');
		t.end();
	});
});

test('send accept-encoding header by default', function (t) {
	got(s.url, function (err, data) {
		t.error(err);

		var headers = JSON.parse(data);

		t.equal(headers['accept-encoding'], 'gzip,deflate');
		t.end();
	});
});

test('send accept header with json option', function (t) {
	got(s.url, {json: true}, function (err, headers) {
		t.error(err);
		t.equal(headers.accept, 'application/json');
		t.end();
	});
});

test('send host header by default', function (t) {
	got(s.url, function (err, data) {
		t.error(err);

		var headers = JSON.parse(data);

		t.equal(headers.host, 'localhost:' + s.port);
		t.end();
	});
});

test('transform headers names to lowercase', function (t) {
	got(s.url, {headers: {'USER-AGENT': 'test'}}, function (err, data) {
		t.error(err);

		var headers = JSON.parse(data);

		t.equal(headers['user-agent'], 'test');
		t.end();
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
