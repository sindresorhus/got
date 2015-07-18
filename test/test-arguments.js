'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.statusCode = 404;
	res.end();
});

s.on('/test', function (req, res) {
	res.end(req.url);
});

s.on('/?test=wow', function (req, res) {
	res.end(req.url);
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('url argument is required', function (t) {
	t.throws(function () {
		got();
	}, /Parameter `url` must be a string or object, not undefined/);
	t.end();
});

test('accepts url.parse object as first argument', function (t) {
	got({hostname: s.host, port: s.port, path: '/test'}, function (err, data) {
		t.error(err);
		t.equal(data, '/test');
		t.end();
	});
});

test('overrides querystring from opts', function (t) {
	got(s.url + '/?test=doge', {query: {test: 'wow'}}, function (err, data) {
		t.error(err);
		t.equal(data, '/?test=wow');
		t.end();
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
