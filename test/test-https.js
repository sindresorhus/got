'use strict';
var test = require('ava');
var pem = require('pem');
var got = require('../');
var server = require('./server.js');

var s;
var key;
var cert;
var caRootKey;
var caRootCert;

test.before('https - create root pem', function (t) {
	pem.createCertificate({
		days: 1,
		selfSigned: true
	}, function (err, keys) {
		t.ifError(err);
		caRootKey = keys.serviceKey;
		caRootCert = keys.certificate;
		t.end();
	});
});

test.before('https - create pem', function (t) {
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
		t.ifError(err);
		key = keys.clientKey;
		cert = keys.certificate;
		t.end();
	});
});

test.before('https - setup', function (t) {
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

test('https - redirects from http to https works', function (t) {
	got('http://github.com', function (err, data) {
		t.ifError(err);
		t.ok(data);
		t.end();
	});
});

test('https - make request to https server', function (t) {
	got('https://google.com', {
		strictSSL: true
	}, function (err, data) {
		t.ifError(err);
		t.ok(data);
		t.end();
	});
});

test('https - make request to https server with ca', function (t) {
	got(s.url, {
		strictSSL: true,
		ca: caRootCert,
		headers: {host: 'sindresorhus.com'}
	}, function (err, data) {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test.after('https - cleanup', function (t) {
	s.close();
	t.end();
});
