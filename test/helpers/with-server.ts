import {promisify} from 'util';
import http = require('http');
import {URL} from 'url';
import tempy = require('tempy');
import createTestServer = require('create-test-server');
import lolex = require('lolex');
import got from '../../source';

export default async (t, run) => {
	const clock = lolex.install();

	const server = await createTestServer({
		bodyParser: {
			type: () => false
		}
	});

	const options = {
		avaTest: t.title,
		handlers: [
			(options, next) => {
				const result = next(options);

				clock.tick(0);

				if (options.lolexResponseTick) {
					result.on('response', () => {
						clock.tick(options.lolexResponseTick);
					});
				}

				return result;
			}
		]
	};

	// @ts-ignore Ignore errors for extending got, for the tests
	const preparedGot = got.extend({prefixUrl: server.url, ...options});
	// @ts-ignore Ignore errors for extending got, for the tests
	preparedGot.secure = got.extend({prefixUrl: server.sslUrl, ...options});

	server.hostname = (new URL(server.url)).hostname;
	server.sslHostname = (new URL(server.sslUrl)).hostname;

	try {
		await run(t, server, preparedGot, clock);
	} finally {
		await server.close();
	}

	clock.uninstall();
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
