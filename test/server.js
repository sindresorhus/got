'use strict';

var http = require('http');
var https = require('https');
var path = require('path');
var fs = require('fs');
var assign = require('object-assign');

exports.port = 6767;
exports.portSSL = 16167;

exports.createServer =  function (port) {
	port = port || exports.port;
	var s = http.createServer(function (req, resp) {
		s.emit(req.url, req, resp);
	});
	s.port = port;
	s.url = 'http://localhost:' + port;
	s.protocol = 'http';
	return s;
};

exports.createSSLServer = function (port, opts) {
	port = port || exports.portSSL;

	var options = assign({
		'key' : path.join(__dirname, 'ssl', 'test.key'),
		'cert': path.join(__dirname, 'ssl', 'test.crt')
	}, opts);

	for (var i in options) {
		options[i] = fs.readFileSync(options[i]);
	}

	var s = https.createServer(options, function (req, resp) {
		s.emit(req.url, req, resp);
	});
	s.port = port;
	s.url = 'https://localhost:' + port;
	s.protocol = 'https';
	return s;
};
