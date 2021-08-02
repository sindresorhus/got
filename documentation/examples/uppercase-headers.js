import http from 'http';
import got from '../../dist/source/index.js';

// Wraps an existing Agent instance
class WrappedAgent {
	constructor(agent) {
		this.agent = agent;
	}

	addRequest(request, options) {
		return this.agent.addRequest(request, options);
	}

	get keepAlive() {
		return this.agent.keepAlive;
	}

	get maxSockets() {
		return this.agent.maxSockets;
	}

	get options() {
		return this.agent.options;
	}

	get defaultPort() {
		return this.agent.defaultPort;
	}

	get protocol() {
		return this.agent.protocol;
	}
}

class TransformHeadersAgent extends WrappedAgent {
	addRequest(request, options) {
		const headers = request.getHeaderNames();

		for (const header of headers) {
			request.setHeader(this.transformHeader(header), request.getHeader(header));
		}

		return super.addRequest(request, options);
	}

	transformHeader(header) {
		return header.split('-').map(part => {
			return part[0].toUpperCase() + part.slice(1);
		}).join('-');
	}
}

const agent = new http.Agent({
	keepAlive: true
});

const wrappedAgent = new TransformHeadersAgent(agent);

const main = async () => {
	const headers = await got(`http://localhost:${server.address().port}`, {
		agent: {
			http: wrappedAgent
		},
		headers: {
			foo: 'bar'
		}
	}).json();

	console.log(headers);

	agent.destroy();
	server.close();
};

const server = http.createServer((request, response) => {
	const {rawHeaders} = request;
	const headers = {};

	for (let i = 0; i < rawHeaders.length; i += 2) {
		headers[rawHeaders[i]] = rawHeaders[i + 1];
	}

	response.end(JSON.stringify(headers));
}).listen(0, main);
