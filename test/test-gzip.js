'use strict';
var zlib = require('zlib');
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();
var testContent = 'Compressible response content.\n';

s.on('/', function (req, res) {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');

	if (/\bgzip\b/i.test(req.headers['accept-encoding'])) {
		res.setHeader('Content-Encoding', 'gzip');
		zlib.gzip(testContent, function (err, data) {
			res.end(data);
		});
	} else {
		res.end(testContent);
	}
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('ungzip content', function (t) {
	got(s.url, function (err, data) {
		t.error(err);
		t.equal(data, testContent);
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
