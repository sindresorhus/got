'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/', function (req, res) {
	res.end(JSON.stringify(req.headers));
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('send user-agent header by default', function (t) {
	got(s.url, function (err, data) {
		var headers = JSON.parse(data);

		t.equal(headers['user-agent'], 'https://github.com/sindresorhus/got');
		t.end();
	});
});

tape('send accept-encoding header by default', function (t) {
	got(s.url, function (err, data) {
		var headers = JSON.parse(data);

		t.equal(headers['accept-encoding'], 'gzip,deflate');
		t.end();
	});
});

tape('send host header by default', function (t) {
	got(s.url, function (err, data) {
		var headers = JSON.parse(data);

		t.equal(headers.host, 'localhost:' + s.port);
		t.end();
	});
});

tape('transform headers names to lowercase', function (t) {
	got(s.url, {headers: {'USER-AGENT': 'test'}}, function (err, data) {
		var headers = JSON.parse(data);

		t.equal(headers['user-agent'], 'test');
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
