import {TLSSocket} from 'tls';
import {Agent as HttpAgent, ServerResponse, IncomingMessage} from 'http';
import {Agent as HttpsAgent} from 'https';
import test, {ExecutionContext} from 'ava';
import sinon from 'sinon';
import withServer, {SecureGot} from './helpers/with-server';

const prepareServer = (server: any): void => {
	server.get('/', (request: IncomingMessage, response: ServerResponse) => {
		if (request.socket instanceof TLSSocket) {
			response.end('https');
		} else {
			response.end('http');
		}
	});

	server.get('/httpsToHttp', (_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(302, {
			location: server.url
		});
		response.end();
	});

	server.get('/httpToHttps', (_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(302, {
			location: server.sslUrl
		});
		response.end();
	});
};

const createAgentSpy = <T extends typeof HttpAgent | typeof HttpsAgent, TConstructed extends HttpAgent | HttpsAgent>(Cls: T): { agent: TConstructed; spy: sinon.SinonSpy } => {
	const agent = new Cls({keepAlive: true}) as TConstructed;
	const spy = sinon.spy(agent, 'requests');
	return {agent, spy};
};

test('non-object agent option works with http', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
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

test('non-object agent option works with https', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpsAgent);

	t.truthy((await got.secure({
		// @ts-ignore
		rejectUnauthorized: false,
		agent
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('redirects from http to https work with an agent object', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	prepareServer(server);

	const {agent: httpAgent, spy: httpSpy} = createAgentSpy<typeof HttpAgent, HttpAgent>(HttpAgent);
	const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy<typeof HttpsAgent, HttpsAgent>(HttpsAgent);

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

test('redirects from https to http work with an agent object', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
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

test('socket connect listener cleaned up after request', withServer, async (t: ExecutionContext, server: any, got: SecureGot) => {
	server.get('/', (_request: IncomingMessage, response: ServerResponse) => {
		response.end('ok');
	});

	const {agent} = createAgentSpy<typeof HttpsAgent, HttpsAgent>(HttpsAgent);

	// Make sure there are no memory leaks when reusing keep-alive sockets
	for (let i = 0; i < 20; i++) {
		// eslint-disable-next-line no-await-in-loop
		await got.secure({
			// @ts-ignore
			rejectUnauthorized: false,
			agent
		});
	}

	for (const value of Object.values(agent.sockets)) {
		for (const sock of value) {
			t.is(sock.listenerCount('connect'), 0);
		}
	}

	// Make sure to close all open sockets
	agent.destroy();
});
