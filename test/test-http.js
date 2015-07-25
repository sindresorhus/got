'use strict';
var test = require('tap').test;
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

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('callback mode', function (t) {
	got(s.url, function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

test('protocol-less URLs', function (t) {
	got(s.url.replace(/^http:\/\//, ''), function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

test('empty response', function (t) {
	got(s.url + '/empty', function (err, data) {
		t.error(err);
		t.equal(data, '');
		t.end();
	});
});

test('error with code', function (t) {
	got(s.url + '/404', function (err, data) {
		t.ok(err);
		t.equal(err.statusCode, 404);
		t.equal(data, 'not');
		t.end();
	});
});

test('buffer on encoding === null', function (t) {
	got(s.url, {encoding: null}, function (err, data) {
		t.error(err);
		t.ok(Buffer.isBuffer(data));
		t.end();
	});
});

test('timeout option', function (t) {
	got(s.url + '/404', {timeout: 1}, function (err) {
		t.equal(err.code, 'ETIMEDOUT');
		t.end();
	});
});

test('query option', function (t) {
	t.plan(4);

	got(s.url, {query: {recent: true}}, function (err, data) {
		t.error(err);
		t.equal(data, 'recent');
	});

	got(s.url, {query: 'recent=true'}, function (err, data) {
		t.error(err);
		t.equal(data, 'recent');
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
