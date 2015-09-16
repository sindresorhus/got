'use strict';
var test = require('ava');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('ok');
});

s.on('/empty', function (req, res) {
	res.end();
});

s.on('/404', function (req, res) {
	setTimeout(function () {
		res.statusCode = 404;
		res.end('not');
	}, 10);
});

s.on('/?recent=true', function (req, res) {
	res.end('recent');
});

test.before('http - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('http - callback mode', function (t) {
	got(s.url, function (err, data) {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('http - protocol-less URLs', function (t) {
	got(s.url.replace(/^http:\/\//, ''), function (err, data) {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('http - empty response', function (t) {
	got(s.url + '/empty', function (err, data) {
		t.ifError(err);
		t.is(data, '');
		t.end();
	});
});

test('http - error with code', function (t) {
	got(s.url + '/404', function (err, data) {
		t.ok(err);
		t.is(err.statusCode, 404);
		t.is(data, 'not');
		t.end();
	});
});

test('http - buffer on encoding === null', function (t) {
	got(s.url, {encoding: null}, function (err, data) {
		t.ifError(err);
		t.ok(Buffer.isBuffer(data));
		t.end();
	});
});

test('http - timeout option', function (t) {
	got(s.url + '/404', {timeout: 1}, function (err) {
		t.is(err.code, 'ETIMEDOUT');
		t.end();
	});
});

test('http - query option', function (t) {
	t.plan(4);

	got(s.url, {query: {recent: true}}, function (err, data) {
		t.ifError(err);
		t.is(data, 'recent');
	});

	got(s.url, {query: 'recent=true'}, function (err, data) {
		t.ifError(err);
		t.is(data, 'recent');
	});
});

test.after('http - cleanup', function (t) {
	s.close();
	t.end();
});
