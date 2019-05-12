import util from 'util';
import http from 'http';
import {URL} from 'url';
import tempy from 'tempy';
import createTestServer from 'create-test-server';
// eslint-disable-next-line ava/use-test
import {ExecutionContext} from 'ava';
import got from '../../source';
import {Got} from '../../source/create';
import {Options} from '../../source/utils/types';

export interface SecureGot extends Got {
	secure: Got;
}

export default async (t: ExecutionContext, run: (t: ExecutionContext, server: any, got: SecureGot) => Promise<void>) => {
	const server = await createTestServer({
		bodyParser: {
			type: () => false
		}
	});

	const preparedGot = got.extend({baseUrl: server.url, avaTest: t.title} as Options & { avaTest: string }) as SecureGot;
	preparedGot.secure = got.extend({baseUrl: server.sslUrl, avaTest: t.title} as Options & { avaTest: string });

	server.hostname = (new URL(server.url)).hostname;
	server.sslHostname = (new URL(server.sslUrl)).hostname;

	try {
		await run(t, server, preparedGot);
	} finally {
		await server.close();
	}
};

// TODO: remove this when `create-test-server` supports custom listen
export const withSocketServer = async (t: ExecutionContext, run: (t: ExecutionContext, server: http.Server) => Promise<void>): Promise<void> => {
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
