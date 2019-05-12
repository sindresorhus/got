import util from 'util';
import http from 'http';
import {URL} from 'url';
import tempy from 'tempy';
import createTestServer from 'create-test-server';
import got from '../../source';

export default async (t, run) => {
	const server = await createTestServer({
		bodyParser: {
			type: () => false
		}
	});

	const preparedGot = got.extend({baseUrl: server.url, avaTest: t.title});
	preparedGot.secure = got.extend({baseUrl: server.sslUrl, avaTest: t.title});

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

	await util.promisify(server.listen.bind(server))(socketPath);

	try {
		await run(t, server);
	} finally {
		await util.promisify(server.close.bind(server))();
	}
};
