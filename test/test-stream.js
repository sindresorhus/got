'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('ok');
});

s.on('/post', function (req, res) {
	req.pipe(res);
});

s.on('/redirect', function (req, res) {
	res.writeHead(302, {
		location: s.url
	});
	res.end();
});

s.on('/error', function (req, res) {
	res.statusCode = 404;
	res.end();
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('json option can not be used in stream mode', function (t) {
	t.throws(function () {
		got.stream(s.url, {json: true});
	}, 'got can not be used as stream when options.json is used');
	t.end();
});

test('return readable stream', function (t) {
	got.stream(s.url)
		.on('data', function (data) {
			t.equal(data.toString(), 'ok');
			t.end();
		});
});

test('return writeable stream', function (t) {
	t.plan(1);
	got.stream.post(s.url + '/post')
		.on('data', function (data) {
			t.equal(data.toString(), 'wow');
		})
		.end('wow');
});

test('throws on write to stream with body specified', function (t) {
	t.throws(function () {
		got.stream(s.url, {body: 'wow'}).write('wow');
	}, 'got\'s stream is not writable when options.body is used');

	// wait for request to end
	setTimeout(t.end.bind(t), 10);
});

test('request event', function (t) {
	got.stream(s.url)
		.on('request', function (req) {
			t.ok(req);
			t.end();
		});
});

test('redirect event', function (t) {
	got.stream(s.url + '/redirect')
		.on('redirect', function (res) {
			t.equal(res.headers.location, s.url);
			t.end();
		});
});

test('response event', function (t) {
	got.stream(s.url)
		.on('response', function (res) {
			t.equal(res.statusCode, 200);
			t.end();
		});
});

test('error event', function (t) {
	t.plan(4);

	got.stream(s.url + '/error')
		.on('error', function (err, data, res) {
			t.equal(err.message, 'Response code 404 (Not Found)');
			t.equal(null, data);
			t.ok(res);
		});

	got.stream('.com')
		.on('error', function (err) {
			t.ok(/getaddrinfo ENOTFOUND/.test(err.message));
		});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
