'use strict';

var tape = require('tape');
var got = require('../');
var server = require('./server.js');

var s = server.createServer();

s.on('/finite', function (req, res) {
	res.writeHead(302, {
		location : s.url + '/'
	});
	res.end();
});

s.on('/endless', function (req, res) {
	res.writeHead(302, {
		location : s.url + '/endless'
	});
	res.end();
});

s.on('/', function (req, res) {
	res.end('reached');
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('follows redirect', function (t) {
	got(s.url + '/finite', {agent: false}, function (err, data) {
		t.error(err);
		t.equal(data, 'reached');
		t.end();
	});
});

tape('throws on endless redirect', function (t) {
	got(s.url + '/endless', {agent: false}, function (err) {
		t.ok(err, 'should get error');
		t.equal(err.message, 'Redirected 10 times. Aborting.');
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
