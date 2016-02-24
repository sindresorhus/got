import test from 'ava';
import pem from 'pem';
import tempfile from 'tempfile';
import pify from 'pify';
import got from '../';
import {format} from 'util';
import {
	createServer, createSSLServer, createProxy
}
from './helpers/server';

const pemP = pify(pem, Promise);
const socketPath = tempfile('.socket');
const proxyEnvVars = [
	'http_proxy',
	'HTTP_PROXY',
	'https_proxy',
	'HTTPS_PROXY',
	'no_proxy',
	'NO_PROXY'
];

let s;
let sipv6;
let p;
let ss;
let socketServer;
let key;
let cert;
let caRootKey;
let caRootCert;

test.before('setup', async() => {
	const caKeys = await pemP.createCertificate({days: 1, selfSigned: true});

	caRootKey = caKeys.serviceKey;
	caRootCert = caKeys.certificate;

	const keys = await pemP.createCertificate({
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

	s = await createServer();
	s.on('/', (req, res) => {
		res.end('ok');
	});
	await s.listen(s.port);

	sipv6 = await createServer();
	sipv6.on('/', (req, res) => {
		res.end('ok');
	});
	await sipv6.listen(sipv6.port, '::1');

	ss = await createSSLServer({key, cert});
	ss.on('/', (req, res) => {
		res.end('ok');
	});
	await ss.listen(ss.port);

	p = await createProxy();
	await p.listen(p.port);

	socketServer = await createServer();

	socketServer.on('/', (req, res) => {
		res.end('ok');
	});

	await socketServer.listen(socketPath);

	proxyEnvVars.forEach(value => delete process.env[value]);
});

test.serial('simple request to http://127.0.0.1 using HTTP_PROXY', async t => {
	process.env.HTTP_PROXY = `http://localhost:${p.port}`;
	t.is((await got(s.url)).body, 'ok');
	t.is((await got(s.url)).req.agent.proxyUri, process.env.HTTP_PROXY);
	delete process.env.HTTP_PROXY;
});

test.serial('simple request to https://127.0.0.1 using HTTPS_PROXY and a http proxy', async t => {
	process.env.HTTPS_PROXY = `http://localhost:${p.port}`;
	t.is((await got(ss.url, {rejectUnauthorized: false})).body, 'ok');
	t.is((await got(ss.url, {rejectUnauthorized: false})).req.agent.proxyUri, process.env.HTTPS_PROXY);
	delete process.env.HTTPS_PROXY;
});

test.serial('simple request to http://127.0.0.1 using http_proxy', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	t.is((await got(s.url)).body, 'ok');
	t.is((await got(s.url)).req.agent.proxyUri, process.env.http_proxy);
	delete process.env.http_proxy;
});

test.serial('simple request to http://127.0.0.1 using http_proxy and no_proxy=*', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `*`;
	t.is((await got(s.url)).body, 'ok');
	t.is((await got(s.url)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial('simple request to http://127.0.0.1 using http_proxy and no_proxy=127.0.0.1/8', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `127.0.0.1/8`;
	t.is((await got(`http://127.0.0.1:${s.port}`)).body, 'ok');
	t.is((await got(`http://127.0.0.1:${s.port}`)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial('simple request to http://127.0.0.1 using http_proxy and no_proxy=127.0.0.1', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `127.0.0.1`;
	t.is((await got(`http://127.0.0.1:${s.port}`)).body, 'ok');
	t.is((await got(`http://127.0.0.1:${s.port}`)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial('simple request to http://localhost using http_proxy and no_proxy=localhost', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `localhost`;
	t.is((await got(s.url)).body, 'ok');
	t.is((await got(s.url)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial('simple request to http://64.233.184.99(google.com) using http_proxy and no_proxy=64.233.0.0/16', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `64.233.0.0/16`;
	t.is((await got('http://64.233.184.99')).statusCode, 200);
	t.is((await got('http://64.233.184.99')).req, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial(`simple request to http://localhost using http_proxy and no_proxy=localhost using same port`, async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `localhost:${s.port}`;
	t.is((await got(s.url)).body, 'ok');
	t.is((await got(s.url)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial(`simple request to http://localhost using http_proxy and no_proxy=localhost using different port`, async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `localhost:80`;
	t.is((await got(s.url)).body, 'ok');
	t.is((await got(s.url)).req.agent.proxyUri, process.env.http_proxy);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial('simple request to http://::1 using http_proxy and no_proxy=::1', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	process.env.no_proxy = `::1`;
	t.is((await got(`http://[::1]:${sipv6.port}`)).body, 'ok');
	t.is((await got(`http://[::1]:${sipv6.port}`)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
	delete process.env.no_proxy;
});

test.serial('simple request to unix socket using http_proxy', async t => {
	process.env.http_proxy = `http://localhost:${p.port}`;
	const url = format('unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
	t.is((await got(url)).req.agent.proxyUri, undefined);
	delete process.env.http_proxy;
});

test.after('cleanup', async() => {
	await s.close();
	await sipv6.close();
	await ss.close();
	await p.close();
	await socketServer.close();
	proxyEnvVars.forEach(value => delete process.env[value]);
});
