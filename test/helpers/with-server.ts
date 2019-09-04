import {promisify} from 'util';
import http = require('http');
import {URL} from 'url';
import tempy = require('tempy');
import createTestServer = require('create-test-server');
import got from '../../source';

export default async (t, run) => {
	const server = await createTestServer({
		bodyParser: {
			type: () => false
		}
	});

	// @ts-ignore Ignore errors for extending got, for the tests
	const preparedGot = got.extend({prefixUrl: server.url, avaTest: t.title});
	// @ts-ignore Ignore errors for extending got, for the tests
	preparedGot.secure = got.extend({prefixUrl: server.sslUrl, avaTest: t.title});

	server.hostname = (new URL(server.url)).hostname;
	server.sslHostname = (new URL(server.sslUrl)).hostname;

	try {
		await run(t, server, preparedGot);
	} finally {
		await server.close();
	}
};

// TODO: remove this when `create-test-server` supports custom listen
export const withSocketServer = async (t, run) => {
	const socketPath = tempy.file({extension: 'socket'});

	const server = http.createServer((request, response) => {
		server.emit(request.url, request, response);
	}) as any;

	server.socketPath = socketPath;

	await promisify(server.listen.bind(server))(socketPath);

	try {
		await run(t, server);
	} finally {
		await promisify(server.close.bind(server))();
	}
};
