'use strict';
var test = require('ava');
var intoStream = require('into-stream');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.setHeader('method', req.method);
	req.pipe(res);
});

s.on('/headers', function (req, res) {
	res.end(JSON.stringify(req.headers));
});

s.on('/empty', function (req, res) {
	res.end();
});

test.before('post - setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('post - GET can have body', function (t) {
	t.plan(3);

	got.get(s.url, {body: 'hi'}, function (err, data, res) {
		t.ifError(err);
		t.is(data, 'hi');
		t.is(res.headers.method, 'GET');
	});
});

test('post - send data from options with post request', function (t) {
	t.plan(6);

	got(s.url, {body: 'wow'}, function (err, data) {
		t.ifError(err);
		t.is(data, 'wow');
	});

	got(s.url, {body: new Buffer('wow')}, function (err, data) {
		t.ifError(err);
		t.is(data, 'wow');
	});

	got(s.url, {body: intoStream(['wow'])}, function (err, data) {
		t.ifError(err);
		t.is(data, 'wow');
	});
});

test('post - works with empty post response', function (t) {
	got(s.url + '/empty', {body: 'wow'}, function (err, data) {
		t.ifError(err);
		t.is(data, '');
		t.end();
	});
});

test('post - post have content-length header to string', function (t) {
	t.plan(10);

	got(s.url + '/headers', {body: 'wow', json: true}, function (err, headers) {
		t.ifError(err);
		t.is(headers['content-length'], '3');
	});

	got(s.url + '/headers', {body: new Buffer('wow'), json: true}, function (err, headers) {
		t.ifError(err);
		t.is(headers['content-length'], '3');
	});

	got(s.url + '/headers', {body: intoStream(['wow']), json: true}, function (err, headers) {
		t.ifError(err);
		t.is(headers['content-length'], undefined);
	});

	got(s.url + '/headers', {body: 'wow', json: true, headers: {'content-length': '10'}}, function (err, headers) {
		t.ifError(err);
		t.is(headers['content-length'], '10');
	});

	got(s.url + '/headers', {body: '3\r\nwow\r\n0\r\n', json: true, headers: {'transfer-encoding': 'chunked'}}, function (err, headers) {
		t.ifError(err);
		t.is(headers['content-length'], undefined);
	});
});

test('post - works with plain object in body', function (t) {
	t.plan(4);

	got(s.url, {body: {such: 'wow'}}, function (err, data) {
		t.ifError(err);
		t.is(data, 'such=wow');
	});

	got(s.url + '/headers', {headers: {'content-type': 'doge'}, body: {such: 'wow'}, json: true}, function (err, headers) {
		t.ifError(err);
		t.is(headers['content-type'], 'doge');
	});
});

test.after('post - cleanup', function (t) {
	s.close();
	t.end();
});
