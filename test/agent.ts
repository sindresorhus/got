import {TLSSocket} from 'tls';
import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import test from 'ava';
import sinon from 'sinon';
import withServer from './helpers/with-server';

const prepareServer = server => {
	server.get('/', (request, response) => {
		if (request.socket instanceof TLSSocket) {
			response.end('https');
		} else {
			response.end('http');
		}
	});

	server.get('/httpsToHttp', (_request, response) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	server.get('/httpToHttps', (_request, response) => {
		response.writeHead(302, {
			location: server.sslUrl
		});
		response.end();
	});
};

const createAgentSpy = Cls => {
	const agent = new Cls({keepAlive: true});
	const spy = sinon.spy(agent, 'addRequest');
	return {agent, spy};
};

test('non-object agent option works with http', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpAgent);

	t.truthy((await got({
		rejectUnauthorized: false,
		agent
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('non-object agent option works with https', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpsAgent);

	t.truthy((await got.secure({
		rejectUnauthorized: false,
		agent
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('redirects from http to https work with an agent object', withServer, async (t, server, got) => {
	prepareServer(server);

	const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
	const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy(HttpsAgent);

	t.truthy((await got('httpToHttps', {
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

test('redirects from https to http work with an agent object', withServer, async (t, server, got) => {
	prepareServer(server);

	const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
	const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy(HttpsAgent);

	t.truthy((await got.secure('httpsToHttp', {
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

test('socket connect listener cleaned up after request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent} = createAgentSpy(HttpsAgent);

	// Make sure there are no memory leaks when reusing keep-alive sockets
	for (let i = 0; i < 20; i++) {
		// eslint-disable-next-line no-await-in-loop
		await got.secure({
			rejectUnauthorized: false,
			agent
		});
	}

	for (const value of Object.values(agent.freeSockets) as [any]) {
		for (const sock of value) {
			t.is(sock.listenerCount('connect'), 0);
		}
	}

	// Make sure to close all open sockets
	agent.destroy();
});
