'use strict';
var test = require('ava');
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

test.before('arguments - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('arguments - url argument is required', function (t) {
	t.plan(2);
	t.throws(function () {
		got(undefined, function () {});
	}, /Parameter `url` must be a string or object, not undefined/);

	got()
		.catch(function (err) {
			t.regexTest(/Parameter `url` must be a string or object, not undefined/, err.message);
		});
});

test('arguments - accepts url.parse object as first argument', function (t) {
	got({hostname: s.host, port: s.port, path: '/test'}, function (err, data) {
		t.ifError(err);
		t.is(data, '/test');
		t.end();
	});
});

test('arguments - overrides querystring from opts', function (t) {
	got(s.url + '/?test=doge', {query: {test: 'wow'}}, function (err, data) {
		t.ifError(err);
		t.is(data, '/?test=wow');
		t.end();
	});
});

test.after('arguments - cleanup', function (t) {
	s.close();
	t.end();
});
