'use strict';
var test = require('ava');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('{"data":"dog"}');
});

s.on('/invalid', function (req, res) {
	res.end('/');
});

s.on('/204', function (req, res) {
	res.statusCode = 204;
	res.end();
});

s.on('/non200', function (req, res) {
	res.statusCode = 500;
	res.end('{"data":"dog"}');
});

s.on('/non200-invalid', function (req, res) {
	res.statusCode = 500;
	res.end('Internal error');
});

test.before('json - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('json - json option should parse response', function (t) {
	got(s.url, {json: true}, function (err, json) {
		t.ifError(err);
		t.same(json, {data: 'dog'});
		t.end();
	});
});

test('json - json option should not parse responses without a body', function (t) {
	got(s.url + '/204', {json: true}, function (err) {
		t.ifError(err);
		t.end();
	});
});

test('json - json option wrap parsing errors', function (t) {
	got(s.url + '/invalid', {json: true}, function (err) {
		t.ok(err);
		t.regexTest(/Unexpected token/, err.message);
		t.ok(err.message.indexOf(err.hostname) !== -1, err.message);
		t.is(err.path, '/invalid');
		t.end();
	});
});

test('json - json option should parse non-200 responses', function (t) {
	got(s.url + '/non200', {json: true}, function (err, json) {
		t.ok(err);
		t.same(json, {data: 'dog'});
		t.end();
	});
});

test('json - json option should catch errors on invalid non-200 responses', function (t) {
	got(s.url + '/non200-invalid', {json: true}, function (err, json) {
		t.ok(err);
		t.regexTest(/Unexpected token/, err.message);
		t.is(json, 'Internal error');
		t.is(err.path, '/non200-invalid');
		t.end();
	});
});

test.after('json - cleanup', function (t) {
	s.close();
	t.end();
});
