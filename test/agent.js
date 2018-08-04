import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import test from 'ava';
import sinon from 'sinon';
import got from '../source';
import {createServer, createSSLServer} from './helpers/server';

let http;
let https;

test.before('setup', async () => {
	https = await createSSLServer();
	http = await createServer();

	// HTTPS Handlers

	https.on('/', (request, response) => {
		response.end('https');
	});

	https.on('/httpsToHttp', (request, response) => {
		response.writeHead(302, {
			location: http.url
		});
		response.end();
	});

	// HTTP Handlers

	http.on('/', (request, response) => {
		response.end('http');
	});

	http.on('/httpToHttps', (request, response) => {
		response.writeHead(302, {
			location: https.url
		});
		response.end();
	});

	await http.listen(http.port);
	await https.listen(https.port);
});

test.after('cleanup', async () => {
	await http.close();
	await https.close();
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
