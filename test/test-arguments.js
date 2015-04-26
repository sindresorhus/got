'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/test', function (req, res) {
	res.end(req.url);
});

s.on('/?test=wow', function (req, res) {
	res.end(req.url);
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('url argument is required', function (t) {
	t.throws(function () {
		got();
	}, /Parameter 'url' must be a string or object, not undefined/);
	t.end();
});

tape('accepts url.parse object as first argument', function (t) {
	got({host: s.host, port: s.port, path: '/test'}, function (err, data) {
		t.error(err);
		t.equal(data, '/test');
		t.end();
	});
});

tape('extends parsed string with opts', function (t) {
	got(s.url, {path: '/test'}, function (err, data) {
		t.error(err);
		t.equal(data, '/test');
		t.end();
	});
});

tape('extends parsed string with opts', function (t) {
	got(s.url + '/?test=doge', {query: {test: 'wow'}}, function (err, data) {
		t.error(err);
		t.equal(data, '/?test=wow');
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
