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
		t.equal(err.code, 404);
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

test('stream mode', function (t) {
	got(s.url)
		.on('data', function (data) {
			t.equal(data.toString(), 'ok');
			t.end();
		});
});

test('emit response object to stream', function (t) {
	got(s.url)
		.on('response', function (res) {
			t.ok(res);
			t.ok(res.headers);
			t.end();
		});
});

test('proxy errors to the stream', function (t) {
	got(s.url + '/404')
		.on('error', function (err, data, res) {
			t.equal(err.code, 404);
			t.equal(data, 'not');
			t.ok(res);
			t.end();
		});
});

test('timeout option', function (t) {
	got(s.url + '/404', {timeout: 1})
		.on('error', function (err) {
			t.equal(err.code, 'ETIMEDOUT');
			t.end();
		});
});

test('query option', function (t) {
	t.plan(2);

	got(s.url, {query: {recent: true}}, function (err, data) {
		t.equal(data, 'recent');
	});

	got(s.url, {query: 'recent=true'}, function (err, data) {
		t.equal(data, 'recent');
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
