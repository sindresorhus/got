'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end('ok');
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('callback mode', {timeout: 1000}, function (t) {
	got.get(s.url, function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

tape('stream mode', {timeout: 1000}, function (t) {
	got.get(s.url)
		.on('data', function (data) {
			t.equal(data.toString(), 'ok');
			t.end();
		});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
