import {promisify} from 'util';
import * as test from 'ava';
import http = require('http');
import tempy = require('tempy');
import createTestServer = require('create-test-server');
import lolex = require('lolex');
import got, {Defaults} from '../../source';
import {ExtendedGot, ExtendedHttpServer, ExtendedTestServer, GlobalClock, InstalledClock} from './types';

export type RunTestWithServer = (t: test.ExecutionContext, server: ExtendedTestServer, got: ExtendedGot, clock: GlobalClock) => Promise<void> | void;
export type RunTestWithSocket = (t: test.ExecutionContext, server: ExtendedHttpServer) => Promise<void> | void;

const generateHook = ({install}: {install?: boolean}): test.Macro<[RunTestWithServer]> => async (t, run) => {
	const clock: GlobalClock = install ? lolex.install() : lolex.createClock();

	const server = await createTestServer({
		bodyParser: {
			type: () => false
		}
	}) as ExtendedTestServer;

	const options: Defaults = {
		// @ts-ignore Augmenting for test detection
		avaTest: t.title,
		handlers: [
			(options, next) => {
				const result = next(options);

				clock.tick(0);

				// @ts-ignore FIXME: Incompatible union type signatures
				result.on('response', () => {
					clock.tick(0);
				});

				return result;
			}
		]
	};

	const preparedGot = got.extend({prefixUrl: server.url, ...options}) as ExtendedGot;
	preparedGot.secure = got.extend({prefixUrl: server.sslUrl, ...options});

	server.hostname = (new URL(server.url)).hostname;
	server.sslHostname = (new URL(server.sslUrl)).hostname;

	try {
		await run(t, server, preparedGot, clock);
	} finally {
		await server.close();
	}

	if (install) {
		(clock as InstalledClock).uninstall();
	}
};

export default generateHook({install: false});

export const withServerAndLolex = generateHook({install: true});

// TODO: remove this when `create-test-server` supports custom listen
export const withSocketServer: test.Macro<[RunTestWithSocket]> = async (t, run) => {
	const socketPath = tempy.file({extension: 'socket'});

	const server = http.createServer((request, response) => {
		server.emit(request.url!, request, response);
	}) as ExtendedHttpServer;

	server.socketPath = socketPath;

	await promisify(server.listen.bind(server))(socketPath);

	try {
		await run(t, server);
	} finally {
		await promisify(server.close.bind(server))();
	}
};
