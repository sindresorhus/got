'use strict';

var tape = require('tape');
var got = require('../');
var server = require('./server.js');

var fs = require('fs');
var path = require('path');

var s = server.createSSLServer(server.portSSL + 1, {
	key: path.resolve(__dirname, 'ssl/ca/server.key'),
	cert: path.resolve(__dirname, 'ssl/ca/server.crt')
});
var caFile = path.resolve(__dirname, 'ssl/ca/ca.crt');
var ca = fs.readFileSync(caFile);

s.on('/', function (req, res) {
	res.end('ok');
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('make request to https server', function (t) {
	got(s.url, {
		strictSSL: true,
		ca: ca,
		headers: { host: 'testing.request.mikealrogers.com' }
	}, function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
