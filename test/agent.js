import util from 'util';
import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import test from 'ava';
import pem from 'pem';
import sinon from 'sinon';
import got from '../source';
import {createServer, createSSLServer} from './helpers/server';

let http;
let https;

const createCertificate = util.promisify(pem.createCertificate);

test.before('setup', async () => {
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

	https = await createSSLServer({key, cert}); // eslint-disable-line object-property-newline
	http = await createServer();

	// HTTPS Handlers

	https.on('/', (req, res) => {
		res.end('https');
	});

	https.on('/httpsToHttp', (req, res) => {
		res.writeHead(302, {
			location: http.url
		});
		res.end();
	});

	// HTTP Handlers

	http.on('/', (req, res) => {
		res.end('http');
	});

	http.on('/httpToHttps', (req, res) => {
		res.writeHead(302, {
			location: https.url
		});
		res.end();
	});

	await http.listen(http.port);
	await https.listen(https.port);
});

const createAgentSpy = Cls => {
	const agent = new Cls({keepAlive: true});
	const spy = sinon.spy(agent, 'addRequest');
	return {agent, spy};
};

test('non-object agent option works with http', async t => {
	const {agent, spy} = createAgentSpy(HttpAgent);

	t.truthy((await got(`${http.url}/`, {
		rejectUnauthorized: false,
		agent
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('non-object agent option works with https', async t => {
	const {agent, spy} = createAgentSpy(HttpsAgent);

	t.truthy((await got(`${https.url}/`, {
		rejectUnauthorized: false,
		agent
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('redirects from http to https work with an agent object', async t => {
	const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
	const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy(HttpsAgent);

	t.truthy((await got(`${http.url}/httpToHttps`, {
		rejectUnauthorized: false,
		agent: {
			http: httpAgent,
			https: httpsAgent
		}
	})).body);
	t.true(httpSpy.calledOnce);
	t.true(httpsSpy.calledOnce);

	// Make sure to close all open sockets
	httpAgent.destroy();
	httpsAgent.destroy();
});

test('redirects from https to http work with an agent object', async t => {
	const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
	const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy(HttpsAgent);

	t.truthy((await got(`${https.url}/httpsToHttp`, {
		rejectUnauthorized: false,
		agent: {
			http: httpAgent,
			https: httpsAgent
		}
	})).body);
	t.true(httpSpy.calledOnce);
	t.true(httpsSpy.calledOnce);

	// Make sure to close all open sockets
	httpAgent.destroy();
	httpsAgent.destroy();
});

test('socket connect listener cleaned up after request', async t => {
	const {agent} = createAgentSpy(HttpsAgent);

	// Make sure there are no memory leaks when reusing keep-alive sockets
	for (let i = 0; i < 20; i++) {
		// eslint-disable-next-line no-await-in-loop
		await got(`${https.url}`, {
			rejectUnauthorized: false,
			agent
		});
	}

	for (const value of Object.values(agent.freeSockets)) {
		for (const sock of value) {
			t.is(sock.listenerCount('connect'), 0);
		}
	}

	// Make sure to close all open sockets
	agent.destroy();
});

test.after('cleanup', async () => {
	await http.close();
	await https.close();
});
