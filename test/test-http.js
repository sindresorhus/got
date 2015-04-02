'use strict';
var tape = require('tape');
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

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('callback mode', function (t) {
	got(s.url, function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

tape('protocol-less URLs', function (t) {
	got(s.url.replace(/^http:\/\//, ''), function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

tape('empty response', function (t) {
	got(s.url + '/empty', function (err, data) {
		t.error(err);
		t.equal(data, '');
		t.end();
	});
});

tape('error with code', function (t) {
	got(s.url + '/404', function (err, data) {
		t.ok(err);
		t.equal(err.code, 404);
		t.equal(data, 'not');
		t.end();
	});
});

tape('buffer on encoding === null', function (t) {
	got(s.url, {encoding: null}, function (err, data) {
		t.error(err);
		t.ok(Buffer.isBuffer(data));
		t.end();
	});
});

tape('stream mode', function (t) {
	got(s.url)
		.on('data', function (data) {
			t.equal(data.toString(), 'ok');
			t.end();
		});
});

tape('emit response object to stream', function (t) {
	got(s.url)
		.on('response', function (res) {
			t.ok(res);
			t.ok(res.headers);
			t.end();
		});
});

tape('proxy errors to the stream', function (t) {
	got(s.url + '/404')
		.on('error', function (err) {
			t.equal(err.code, 404);
			t.end();
		});
});

tape('timeout option', function (t) {
	got(s.url + '/404', {timeout: 1})
		.on('error', function (err) {
			t.equal(err.code, 'ETIMEDOUT');
			t.end();
		});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
