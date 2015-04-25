'use strict';
var tape = require('tape');
var got = require('../');
var server = require('./server.js');
var s = server.createServer();
var urlLib = require('url');
var infinityAgent = require('infinity-agent');

s.on('/', function (req, res) {
	res.end('ok');
});

s.on('/redirect', function (req, res) {
	res.setHeader('Location', '/');
	res.statusCode = 302;
	res.end();
});

tape('setup', function (t) {
	s.listen(s.port, function () {
		t.end();
	});
});

tape('String url, Object opts, Function, cb', function (t) {
	var urlObj = urlLib.parse(s.url);
	got(s.url + '/404', urlObj, function (err, data) {
		t.equal(data, 'ok');
		t.end();
	});
});

tape('Object url, Function, cb', function (t) {
	got(urlLib.parse(s.url), function (err, data) {
		t.equal(data, 'ok');
		t.end();
	});
});

tape('Should not modify original options', function (t) {
	var opts = urlLib.parse(s.url + '/redirect');
	t.equal(opts.path, '/redirect');
	got(opts, function (err, data) {
		t.equal(data, 'ok');
		t.equal(opts.path, '/redirect');
		t.end();
	});
});

tape('Should not rewrite passed agent on redirects', function (t) {
	var agent = new infinityAgent.http.Agent();
	var addRequest = agent.addRequest;
	var spy = [];
	agent.addRequest = function (req) {
		spy.push(req.path);
		return addRequest.apply(this, arguments);
	};
	got(s.url + '/redirect', {agent: agent}, function (err, data) {
		t.equal(data, 'ok');
		t.deepEqual(spy, ['/redirect', '/']);
		t.end();
	});
});

tape('cleanup', function (t) {
	s.close();
	t.end();
});
