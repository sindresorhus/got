'use strict';
var http = require('http');
var https = require('https');

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

	var s = https.createServer(opts, function (req, resp) {
		s.emit(req.url, req, resp);
	});

	s.port = port;
	s.url = 'https://localhost:' + port;
	s.protocol = 'https';

	return s;
};
