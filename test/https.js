import test from 'ava';
import pem from 'pem';
import got from '../';
import {createSSLServer, portSSL} from './_server';

let s;
let key;
let cert;
let caRootKey;
let caRootCert;

test.before('https - create root pem', t => {
	pem.createCertificate({
		days: 1,
		selfSigned: true
	}, (err, keys) => {
		t.ifError(err);
		caRootKey = keys.serviceKey;
		caRootCert = keys.certificate;
		t.end();
	});
});

test.before('https - create pem', t => {
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
	}, (err, keys) => {
		t.ifError(err);
		key = keys.clientKey;
		cert = keys.certificate;
		t.end();
	});
});

test.before('https - setup', t => {
	s = createSSLServer(portSSL + 1, {key, cert});
	s.on('/', (req, res) => res.end('ok'));
	s.listen(s.port, () => t.end());
});

test('https - redirects from http to https works', async t => {
	t.ok((await got('http://github.com')).body);
});

test('https - make request to https server', async t => {
	t.ok((await got('https://google.com', {strictSSL: true})).body);
});

test('https - make request to https server with ca', async t => {
	const {body} = await got(s.url, {
		strictSSL: true,
		ca: caRootCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});

test.after('https - cleanup', t => {
	s.close();
	t.end();
});
