'use strict';
var http = require('http');
var https = require('https');

exports.host = 'localhost';
exports.port = 6767;
exports.portSSL = 16167;

exports.createServer = function (port) {
	var host = exports.host;

	port = port || exports.port;

	exports.port += 1;

	var s = http.createServer(function (req, resp) {
		s.emit(req.url, req, resp);
	});

	s.host = host;
	s.port = port;
	s.url = 'http://' + host + ':' + port;
	s.protocol = 'http';

	return s;
};

exports.createSSLServer = function (port, opts) {
	var host = exports.host;

	port = port || exports.portSSL;

	exports.portSSL += 1;

	var s = https.createServer(opts, function (req, resp) {
		s.emit(req.url, req, resp);
	});

	s.host = host;
	s.port = port;
	s.url = 'https://' + host + ':' + port;
	s.protocol = 'https';

	return s;
};
