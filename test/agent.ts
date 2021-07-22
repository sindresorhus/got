import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import test, {Constructor} from 'ava';
import sinon from 'sinon';
import withServer, {withHttpsServer} from './helpers/with-server.js';

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
			rejectUnauthorized: false,
		},
		agent: {
			http: agent,
		},
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('non-object agent option works with https', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpsAgent);

	t.truthy((await got({
		https: {
			rejectUnauthorized: false,
		},
		agent: {
			https: agent,
		},
	})).body);
	t.true(spy.calledOnce);

	// Make sure to close all open sockets
	agent.destroy();
});

test('redirects from http to https work with an agent object', withServer, async (t, serverHttp) => {
	await withHttpsServer()(t, async (t, serverHttps, got) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttp.get('/httpToHttps', (_request, response) => {
			response.writeHead(302, {
				location: serverHttps.url,
			});
			response.end();
		});

		const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
		const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy<HttpsAgent>(HttpsAgent);

		t.truthy((await got('httpToHttps', {
			prefixUrl: serverHttp.url,
			agent: {
				http: httpAgent,
				https: httpsAgent,
			},
		})).body);
		t.true(httpSpy.calledOnce);
		t.true(httpsSpy.calledOnce);

		// Make sure to close all open sockets
		httpAgent.destroy();
		httpsAgent.destroy();
	});
});

test('redirects from https to http work with an agent object', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer(t, async (t, serverHttp) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttps.get('/httpsToHttp', (_request, response) => {
			response.writeHead(302, {
				location: serverHttp.url,
			});
			response.end();
		});

		const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
		const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy(HttpsAgent);

		t.truthy((await got('httpsToHttp', {
			prefixUrl: serverHttps.url,
			agent: {
				http: httpAgent,
				https: httpsAgent,
			},
		})).body);
		t.true(httpSpy.calledOnce);
		t.true(httpsSpy.calledOnce);

		// Make sure to close all open sockets
		httpAgent.destroy();
		httpsAgent.destroy();
	});
});

test('socket connect listener cleaned up after request', withHttpsServer(), async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent} = createAgentSpy(HttpsAgent);

	// Make sure there are no memory leaks when reusing keep-alive sockets
	for (let index = 0; index < 20; index++) {
		// eslint-disable-next-line no-await-in-loop
		await got({
			agent: {
				https: agent,
			},
		});
	}

	for (const value of Object.values(agent.freeSockets)) {
		if (!value) {
			continue;
		}

		for (const sock of value) {
			t.is(sock.listenerCount('connect'), 0);
		}
	}

	// Make sure to close all open sockets
	agent.destroy();
});

test('no socket hung up regression', withServer, async (t, server, got) => {
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
		agent: {
			http: agent,
		},
		hooks: {
			afterResponse: [
				async (response, retryWithMergedOptions) => {
					// Force clean-up
					// eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
					response.socket?.destroy();

					// Unauthorized
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token,
							},
						});
					}

					// No changes otherwise
					return response;
				},
			],
		},
		// Disable automatic retries, manual retries are allowed
		retry: {
			limit: 0,
		},
	});

	t.is(body, 'ok');

	agent.destroy();
});
