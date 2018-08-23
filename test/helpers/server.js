'use strict';
const util = require('util');
const http = require('http');
const https = require('https');
const getPort = require('get-port');
const pem = require('pem');

exports.host = 'localhost';
const {host} = exports;

const createCertificate = util.promisify(pem.createCertificate);

exports.createServer = async () => {
	const port = await getPort();

	const s = http.createServer((request, response) => {
		const event = decodeURI(request.url);
		if (s.listeners(event).length === 0) {
			response.writeHead(404, 'Not Found');
			response.end(`No listener for ${event}`);
		} else {
			s.emit(event, request, response);
		}
	});

	s.host = host;
	s.port = port;
	s.url = `http://${host}:${port}`;
	s.protocol = 'http';

	s.listen = util.promisify(s.listen);
	s.close = util.promisify(s.close);

	return s;
};

exports.createSSLServer = async () => {
	const port = await getPort();

	const caKeys = await createCertificate({
		days: 1,
		selfSigned: true
	});

	const caRootKey = caKeys.serviceKey;
	const caRootCert = caKeys.certificate;

	const keys = await createCertificate({
		serviceCertificate: caRootCert,
		serviceKey: caRootKey,
		serial: Date.now(),
		days: 500,
		country: '',
		state: '',
		locality: '',
		organization: '',
		organizationUnit: '',
		commonName: 'sindresorhus.com'
	});

	const key = keys.clientKey;
	const cert = keys.certificate;

	const s = https.createServer({cert, key}, (request, response) => {
		s.emit(request.url, request, response);
	});

	s.host = host;
	s.port = port;
	s.url = `https://${host}:${port}`;
	s.protocol = 'https';
	s.caRootCert = caRootCert;

	s.listen = util.promisify(s.listen);
	s.close = util.promisify(s.close);

	return s;
};
