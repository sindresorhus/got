'use strict';
var test = require('ava');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end(JSON.stringify(req.headers));
});

test.before('headers - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('headers - send user-agent header by default', function (t) {
	got(s.url, function (err, data) {
		t.ifError(err);

		var headers = JSON.parse(data);

		t.is(headers['user-agent'], 'https://github.com/sindresorhus/got');
		t.end();
	});
});

test('headers - send accept-encoding header by default', function (t) {
	got(s.url, function (err, data) {
		t.ifError(err);

		var headers = JSON.parse(data);

		t.is(headers['accept-encoding'], 'gzip,deflate');
		t.end();
	});
});

test('headers - send accept header with json option', function (t) {
	got(s.url, {json: true}, function (err, headers) {
		t.ifError(err);
		t.is(headers.accept, 'application/json');
		t.end();
	});
});

test('headers - send host header by default', function (t) {
	got(s.url, function (err, data) {
		t.ifError(err);

		var headers = JSON.parse(data);

		t.is(headers.host, 'localhost:' + s.port);
		t.end();
	});
});

test('headers - transform headers names to lowercase', function (t) {
	got(s.url, {headers: {'USER-AGENT': 'test'}}, function (err, data) {
		t.ifError(err);

		var headers = JSON.parse(data);

		t.is(headers['user-agent'], 'test');
		t.end();
	});
});

test.after('headers - cleanup', function (t) {
	s.close();
	t.end();
});
