import util from 'util';
import test from 'ava';
import pem from 'pem';
import got from '../source';
import {createSSLServer} from './helpers/server';

let s;
let caRootCert;

const createCertificate = util.promisify(pem.createCertificate);

test.before('setup', async () => {
	const caKeys = await createCertificate({
		days: 1,
		selfSigned: true
	});

	const caRootKey = caKeys.serviceKey;
	caRootCert = caKeys.certificate;

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

	s = await createSSLServer({key, cert});

	s.on('/', (request, response) => response.end('ok'));

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('make request to https server without ca', async t => {
	t.truthy((await got(s.url, {rejectUnauthorized: false})).body);
});

test('make request to https server with ca', async t => {
	const {body} = await got(s.url, {
		ca: caRootCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});

test('protocol-less URLs default to HTTPS', async t => {
	const {body, requestUrl} = await got(s.url.replace(/^https:\/\//, ''), {
		ca: caRootCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
	t.true(requestUrl.startsWith('https://'));
});

