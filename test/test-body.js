'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();

s.on('/echo', function (req, res) {
	req.pipe(res);
});

s.on('/ct', function (req, res) {
	res.end(req.headers['content-type']);
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('Object in options.body goes through JSON.stringify', function (t) {
	got(s.url + '/echo', {body: {data: 'wow'}}, function (err, data) {
		t.error(err);
		t.equal(data, '{"data":"wow"}');
		t.end();
	});
});

tape('Content-Type is defaulted to application/json', function (t) {
	t.plan(4);

	got(s.url + '/ct', {body: {data: 'wow'}}, function (err, data) {
		t.error(err);
		t.equal(data, 'application/json');
	});

	got(s.url + '/ct', {body: {data: 'wow'}, headers: {'content-type': 'text/json'}}, function (err, data) {
		t.error(err);
		t.equal(data, 'text/json');
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
