import test from 'ava';
import pem from 'pem';
import pify from 'pify';
import got from '../';
import {createSSLServer, portSSL} from './_server';

let s;
let key;
let cert;
let caRootKey;
let caRootCert;

let pemify = pify.all(pem);

test.before('https - create root pem', async t => {
	const keys = await pemify.createCertificate({days: 1, selfSigned: true});

	caRootKey = keys.serviceKey;
	caRootCert = keys.certificate;
});

test.before('https - create pem', async t => {
	const keys = await pemify.createCertificate({
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

	key = keys.clientKey;
	cert = keys.certificate;
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
