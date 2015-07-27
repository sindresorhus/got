'use strict';
var test = require('tap').test;
var intoStream = require('into-stream');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	req.pipe(res);
});

s.on('/headers', function (req, res) {
	res.end(JSON.stringify(req.headers));
});

s.on('/method', function (req, res) {
	res.setHeader('method', req.method);
	res.end();
});

s.on('/empty', function (req, res) {
	res.end();
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('GET can have body', function (t) {
	t.plan(3);

	var stream = intoStream(['wow']);

	stream.on('end', function () {
		// ensure that stream was dumped
		t.ok(true);
	});

	got.get(s.url + '/method', {body: stream}, function (err, data, res) {
		t.error(err);
		t.equal(res.headers.method, 'GET');
	});
});

test('send data from options with post request', function (t) {
	t.plan(6);

	got(s.url, {body: 'wow'}, function (err, data) {
		t.error(err);
		t.equal(data, 'wow');
	});

	got(s.url, {body: new Buffer('wow')}, function (err, data) {
		t.error(err);
		t.equal(data, 'wow');
	});

	got(s.url, {body: intoStream(['wow'])}, function (err, data) {
		t.error(err);
		t.equal(data, 'wow');
	});
});

test('works with empty post response', function (t) {
	got(s.url + '/empty', {body: 'wow'}, function (err, data) {
		t.error(err);
		t.equal(data, '');
		t.end();
	});
});

test('post have content-length header to string', function (t) {
	t.plan(10);

	got(s.url + '/headers', {body: 'wow', json: true}, function (err, headers) {
		t.error(err);
		t.equal(headers['content-length'], '3');
	});

	got(s.url + '/headers', {body: new Buffer('wow'), json: true}, function (err, headers) {
		t.error(err);
		t.equal(headers['content-length'], '3');
	});

	got(s.url + '/headers', {body: intoStream(['wow']), json: true}, function (err, headers) {
		t.error(err);
		t.equal(headers['content-length'], undefined);
	});

	got(s.url + '/headers', {body: 'wow', json: true, headers: {'content-length': '10'}}, function (err, headers) {
		t.error(err);
		t.equal(headers['content-length'], '10');
	});

	got(s.url + '/headers', {body: '3\r\nwow\r\n0\r\n', json: true, headers: {'transfer-encoding': 'chunked'}}, function (err, headers) {
		t.error(err);
		t.equal(headers['content-length'], undefined);
	});
});

test('works with plain object in body', function (t) {
	t.plan(4);

	got(s.url, {body: {such: 'wow'}}, function (err, data) {
		t.error(err);
		t.equal(data, 'such=wow');
	});

	got(s.url + '/headers', {headers: {'content-type': 'doge'}, body: {such: 'wow'}, json: true}, function (err, headers) {
		t.error(err);
		t.equal(headers['content-type'], 'doge');
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
