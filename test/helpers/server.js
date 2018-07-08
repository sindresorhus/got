'use strict';
const util = require('util');
const http = require('http');
const https = require('https');
const getPort = require('get-port');

exports.host = 'localhost';
const {host} = exports;

exports.createServer = async () => {
	const port = await getPort();

	const s = http.createServer((request, response) => {
		s.emit(request.url, request, response);
	});

	s.host = host;
	s.port = port;
	s.url = `http://${host}:${port}`;
	s.protocol = 'http';

	s.listen = util.promisify(s.listen);
	s.close = util.promisify(s.close);

	return s;
};

exports.createSSLServer = async options => {
	const port = await getPort();

	const s = https.createServer(options, (request, response) => {
		s.emit(request.url, request, response);
	});

	s.host = host;
	s.port = port;
	s.url = `https://${host}:${port}`;
	s.protocol = 'https';

	s.listen = util.promisify(s.listen);
	s.close = util.promisify(s.close);

	return s;
};
