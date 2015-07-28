'use strict';
var test = require('tap').test;
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('ok');
});

s.on('/404', function (req, res) {
	res.statusCode = 404;
	res.end('not found');
});

test('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

test('callback mode', function (t) {
	got.get(s.url, function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

test('promise mode', function (t) {
	t.plan(3);

	got.get(s.url)
		.then(function (res) {
			t.equal(res.body, 'ok');
		});

	got.get(s.url + '/404')
		.catch(function (err) {
			t.equal(err.response.body, 'not found');
		});

	got.get('.com')
		.catch(function (err) {
			t.ok(err);
		});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
