'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('{"data":"dog"}');
});

s.on('/invalid', function (req, res) {
	res.end('/');
});

s.on('/non200', function (req, res) {
	res.statusCode = 500;
	res.end('{"data":"dog"}');
});

s.on('/non200-invalid', function (req, res) {
	res.statusCode = 500;
	res.end('Internal error');
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('json option can not be used in stream mode', function (t) {
	t.throws(function () {
		got(s.url, {json: true});
	}, 'got can not be used as stream when options.json is used');
	t.end();
});

tape('json option should parse response', function (t) {
	got(s.url, {json: true}, function (err, json) {
		t.error(err);
		t.deepEqual(json, {data: 'dog'});
		t.end();
	});
});

tape('json option wrap parsing errors', function (t) {
	got(s.url + '/invalid', {json: true}, function (err) {
		t.ok(err);
		t.equal(err.message, 'Parsing ' + s.url + '/invalid response failed');
		t.end();
	});
});

tape('json option should parse non-200 responses', function (t) {
	got(s.url + '/non200', {json: true}, function (err, json) {
		t.ok(err);
		t.deepEqual(json, {data: 'dog'});
		t.end();
	});
});

tape('json option should catch errors on invalid non-200 responses', function (t) {
	got(s.url + '/non200-invalid', {json: true}, function (err, json) {
		t.ok(err);
		t.deepEqual(json, 'Internal error');
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
