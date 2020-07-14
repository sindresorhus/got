import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import {Socket} from 'net';
import {TLSSocket} from 'tls';
import test, {Constructor} from 'ava';
import sinon = require('sinon');
import {ExtendedTestServer} from './helpers/types';
import withServer from './helpers/with-server';

const prepareServer = (server: ExtendedTestServer): void => {
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

const createAgentSpy = <T extends HttpsAgent>(AgentClass: Constructor): {agent: T; spy: sinon.SinonSpy} => {
	const agent: T = new AgentClass({keepAlive: true});
	// @ts-expect-error This IS correct
	const spy = sinon.spy(agent, 'addRequest');
	return {agent, spy};
};

test('non-object agent option works with http', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpAgent);

	t.truthy((await got({
		https: {
			rejectUnauthorized: false
		},
		agent: {
			http: agent
		}
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
		https: {
			rejectUnauthorized: false
		},
		agent: {
			https: agent
		}
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('redirects from http to https work with an agent object', withServer, async (t, server, got) => {
	prepareServer(server);

	const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
	const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy<HttpsAgent>(HttpsAgent);

	t.truthy((await got('httpToHttps', {
		https: {
			rejectUnauthorized: false
		},
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
		https: {
			rejectUnauthorized: false
		},
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
			https: {
				rejectUnauthorized: false
			},
			agent: {
				https: agent
			}
		});
	}

	// Node.js 12 has incomplete types
	for (const value of Object.values((agent as any).freeSockets) as [Socket[]]) {
		for (const sock of value) {
			t.is(sock.listenerCount('connect'), 0);
		}
	}

	// Make sure to close all open sockets
	agent.destroy();
});

{
	const testFn = Number(process.versions.node.split('.')[0]) < 12 ? test.failing : test;

	testFn('no socket hung up regression', withServer, async (t, server, got) => {
		const agent = new HttpAgent({keepAlive: true});
		const token = 'helloworld';

		server.get('/', (request, response) => {
			if (request.headers.token !== token) {
				response.statusCode = 401;
				response.end();
				return;
			}

			response.end('ok');
		});

		const {body} = await got({
			prefixUrl: 'http://127.0.0.1:3000',
			agent: {
				http: agent
			},
			hooks: {
				afterResponse: [
					async (response, retryWithMergedOptions) => {
						// Force clean-up
						response.socket?.destroy();

						// Unauthorized
						if (response.statusCode === 401) {
							return retryWithMergedOptions({
								headers: {
									token
								}
							});
						}

						// No changes otherwise
						return response;
					}
				]
			},
			// Disable automatic retries, manual retries are allowed
			retry: 0
		});

		t.is(body, 'ok');

		agent.destroy();
	});
}
