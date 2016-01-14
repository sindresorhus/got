import test from 'ava';
import pem from 'pem';
import pify from 'pify';
import got from '../';
import {createSSLServer} from './helpers/server';

let s;
let key;
let cert;
let caRootKey;
let caRootCert;

let pemP = pify(pem, Promise);

test.before('setup', async () => {
	let caKeys = await pemP.createCertificate({days: 1, selfSigned: true});

	caRootKey = caKeys.serviceKey;
	caRootCert = caKeys.certificate;

	let keys = await pemP.createCertificate({
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

	s = await createSSLServer({key, cert});

	s.on('/', (req, res) => res.end('ok'));

	await s.listen(s.port);
});

test('redirects from http to https works', async t => {
	t.ok((await got('http://github.com')).body);
});

test('make request to https server', async t => {
	t.ok((await got('https://google.com', {strictSSL: true})).body);
});

test('make request to https server with ca', async t => {
	let {body} = await got(s.url, {
		strictSSL: true,
		ca: caRootCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});

test.after('cleanup', async () => {
	await s.close();
});
