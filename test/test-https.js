'use strict';
var test = require('tap').test;
var pem = require('pem');
var got = require('../');
var server = require('./server.js');

var s;
var key;
var cert;
var caRootKey;
var caRootCert;

test('root pem', function (t) {
	pem.createCertificate({
		days: 1,
		selfSigned: true
	}, function (err, keys) {
		t.error(err);
		caRootKey = keys.serviceKey;
		caRootCert = keys.certificate;
		t.end();
	});
});

test('pem', function (t) {
	pem.createCertificate({
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
	}, function (err, keys) {
		t.error(err);
		key = keys.clientKey;
		cert = keys.certificate;
		t.end();
	});
});

test('setup', function (t) {
	s = server.createSSLServer(server.portSSL + 1, {
		key: key,
		cert: cert
	});

	s.on('/', function (req, res) {
		res.end('ok');
	});

	s.listen(s.port, function () {
		t.end();
	});
});

test('redirects from http to https works', function (t) {
	got('http://github.com', function (err, data) {
		t.error(err);
		t.ok(data);
		t.end();
	});
});

test('make request to https server', function (t) {
	got('https://google.com', {
		strictSSL: true
	}, function (err, data) {
		t.error(err);
		t.ok(data);
		t.end();
	});
});

test('make request to https server with ca', function (t) {
	got(s.url, {
		strictSSL: true,
		ca: caRootCert,
		headers: {host: 'sindresorhus.com'}
	}, function (err, data) {
		t.error(err);
		t.equal(data, 'ok');
		t.end();
	});
});

test('cleanup', function (t) {
	s.close();
	t.end();
});
