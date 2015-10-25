'use strict';
var http = require('http');
var https = require('https');
var pify = require('pify');
var getPort = require('get-port');
var getPortP = pify(getPort);
var host = exports.host = 'localhost';

exports.createServer = function () {
	return getPortP().then(function (port) {
		var s = http.createServer(function (req, resp) {
			s.emit(req.url, req, resp);
		});

		s.host = host;
		s.port = port;
		s.url = 'http://' + host + ':' + port;
		s.protocol = 'http';

		s.listen = pify(s.listen);
		s.close = pify(s.close);

		return s;
	});
};

exports.createSSLServer = function (opts) {
	return getPortP().then(function (port) {
		var s = https.createServer(opts, function (req, resp) {
			s.emit(req.url, req, resp);
		});

		s.host = host;
		s.port = port;
		s.url = 'https://' + host + ':' + port;
		s.protocol = 'https';

		s.listen = pify(s.listen);
		s.close = pify(s.close);

		return s;
	});
};
