import {Agent as HttpAgent} from 'node:http';
import {Agent as HttpsAgent} from 'node:https';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import type {Constructor} from 'type-fest';
import test from './helpers/test.js';
import withServer, {withHttpsServer} from './helpers/with-server.js';

const createAgentSpy = <T extends HttpsAgent>(AgentClass: Constructor<any>): {agent: T; spy: sinon.SinonSpy} => {
	const agent: T = new AgentClass({keepAlive: true});
	const spy = sinon.spy(agent, 'addRequest' as any);
	return {agent, spy};
};

test('non-object agent option works with http', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpAgent);

	assert.ok((await got({
		https: {
			rejectUnauthorized: false,
		},
		agent: {
			http: agent,
		},
	})).body);
	assert.strictEqual(spy.calledOnce, true);

	// Make sure to close all open sockets
	agent.destroy();
});

test('non-object agent option works with https', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent, spy} = createAgentSpy(HttpsAgent);

	assert.ok((await got({
		https: {
			rejectUnauthorized: false,
		},
		agent: {
			https: agent,
		},
	})).body);
	assert.strictEqual(spy.calledOnce, true);

	// Make sure to close all open sockets
	agent.destroy();
});

test('redirects from http to https work with an agent object', withServer, async (t, serverHttp) => {
	await withHttpsServer()(t, async (_t, serverHttps, got) => {
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

		assert.ok((await got('httpToHttps', {
			prefixUrl: serverHttp.url,
			agent: {
				http: httpAgent,
				https: httpsAgent,
			},
		})).body);
		assert.strictEqual(httpSpy.calledOnce, true);
		assert.strictEqual(httpsSpy.calledOnce, true);

		// Make sure to close all open sockets
		httpAgent.destroy();
		httpsAgent.destroy();
	});
});

test('redirects from https to http work with an agent object', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer(t, async (_t, serverHttp) => {
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

		assert.ok((await got('httpsToHttp', {
			prefixUrl: serverHttps.url,
			agent: {
				http: httpAgent,
				https: httpsAgent,
			},
		})).body);
		assert.strictEqual(httpSpy.calledOnce, true);
		assert.strictEqual(httpsSpy.calledOnce, true);

		// Make sure to close all open sockets
		httpAgent.destroy();
		httpsAgent.destroy();
	});
});

test('socket connect listener cleaned up after request', withHttpsServer(), async (_t, server, got) => {
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
			assert.strictEqual(sock.listenerCount('connect'), 0);
		}
	}

	// Make sure to close all open sockets
	agent.destroy();
});

test('no socket hung up regression', withServer, async (_t, server, got) => {
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

	assert.strictEqual(body, 'ok');

	agent.destroy();
});

test('accept undefined agent', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const undefinedAgent = undefined;
	assert.ok((await got({
		https: {
			rejectUnauthorized: false,
		},
		agent: undefinedAgent,
	})).body);
});

test('accept false as agent value', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// Should not throw error when setting agent types to false
	assert.doesNotThrow(() => got.extend({
		agent: {
			http: false,
			https: false,
			http2: false,
		},
	}));

	// Should successfully make request with false agent values
	const response = await got({
		agent: {
			http: false,
		},
	});

	assert.strictEqual(response.body, 'ok');
});

test('accept mixed agent values with false', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {agent: httpAgent} = createAgentSpy(HttpAgent);

	// Should accept a mix of agent instance and false values
	const response = await got({
		agent: {
			http: httpAgent,
			https: false,
			http2: false,
		},
	});

	assert.strictEqual(response.body, 'ok');

	httpAgent.destroy();
});

test('a per-request agent merges with the agent an instance sets for another protocol', withServer, async (t, serverHttp) => {
	await withHttpsServer()(t, async (_t, serverHttps, got) => {
		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttp.get('/', (_request, response) => {
			response.writeHead(302, {
				location: serverHttps.url,
			});
			response.end();
		});

		const {agent: httpAgent, spy: httpSpy} = createAgentSpy(HttpAgent);
		const {agent: httpsAgent, spy: httpsSpy} = createAgentSpy<HttpsAgent>(HttpsAgent);
		t.after(() => {
			httpAgent.destroy();
			httpsAgent.destroy();
		});

		const instance = got.extend({
			prefixUrl: '',
			agent: {
				http: httpAgent,
			},
		});

		const {body} = await instance(serverHttp.url, {
			agent: {
				https: httpsAgent,
			},
		});

		assert.strictEqual(body, 'https');
		assert.strictEqual(httpSpy.callCount, 1);
		assert.strictEqual(httpsSpy.callCount, 1);
	});
});

test('agent.http is used for plain HTTP URLs when http2 is enabled', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end(request.httpVersion);
	});

	const {agent, spy} = createAgentSpy(HttpAgent);
	t.after(() => {
		agent.destroy();
	});

	const {body} = await got({
		http2: true,
		agent: {
			http: agent,
		},
	});

	assert.strictEqual(body, '1.1');
	assert.strictEqual(spy.callCount, 1);
});
