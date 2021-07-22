import http from 'http';
import {promisify} from 'util';
import {ExecutionContext, Macro} from 'ava'; // eslint-disable-line ava/use-test
import is from '@sindresorhus/is';
import tempy from 'tempy';
import FakeTimers from '@sinonjs/fake-timers';
import got, {Got, ExtendOptions} from '../../source/index.js';
import createHttpsTestServer, {ExtendedHttpsTestServer, HttpsServerOptions} from './create-https-test-server.js';
import createHttpTestServer, {ExtendedHttpTestServer, HttpServerOptions} from './create-http-test-server.js';
import {ExtendedHttpServer, GlobalClock, InstalledClock} from './types.js';

export type RunTestWithServer = (t: ExecutionContext, server: ExtendedHttpTestServer, got: Got, clock: GlobalClock) => Promise<void> | void;
export type RunTestWithHttpsServer = (t: ExecutionContext, server: ExtendedHttpsTestServer, got: Got, fakeTimer?: GlobalClock) => Promise<void> | void;
export type RunTestWithSocket = (t: ExecutionContext, server: ExtendedHttpServer) => Promise<void> | void;

const generateHook = ({install, options: testServerOptions}: {install?: boolean; options?: HttpServerOptions}): Macro<[RunTestWithServer]> => async (t, run) => {
	const clock = install ? FakeTimers.install() : FakeTimers.createClock() as GlobalClock;

	// Re-enable body parsing to investigate https://github.com/sindresorhus/got/issues/1186
	const server = await createHttpTestServer(is.plainObject(testServerOptions) ? testServerOptions : {
		bodyParser: {
			type: () => false,
		} as any,
	});

	const options: ExtendOptions = {
		context: {
			avaTest: t.title,
		},
		handlers: [
			(options, next) => {
				const result = next(options);

				clock.tick(0);

				// @ts-expect-error FIXME: Incompatible union type signatures
				result.on('response', () => {
					clock.tick(0);
				});

				return result;
			},
		],
	};

	const preparedGot = got.extend({prefixUrl: server.url, ...options});

	try {
		await run(t, server, preparedGot, clock);
	} finally {
		await server.close();
	}

	if (install) {
		(clock as InstalledClock).uninstall();
	}
};

export const withBodyParsingServer = generateHook({install: false, options: {}});
export default generateHook({install: false});

export const withServerAndFakeTimers = generateHook({install: true});

const generateHttpsHook = (options?: HttpsServerOptions, installFakeTimer = false): Macro<[RunTestWithHttpsServer]> => async (t, run) => {
	const fakeTimer = installFakeTimer ? FakeTimers.install() as GlobalClock : undefined;

	const server = await createHttpsTestServer(options);

	const preparedGot = got.extend({
		context: {
			avaTest: t.title,
		},
		handlers: [
			(options, next) => {
				const result = next(options);

				fakeTimer?.tick(0);

				// @ts-expect-error FIXME: Incompatible union type signatures
				result.on('response', () => {
					fakeTimer?.tick(0);
				});

				return result;
			},
		],
		prefixUrl: server.url,
		https: {
			certificateAuthority: (server as any).caCert,
			rejectUnauthorized: true,
		},
	});

	try {
		await run(t, server, preparedGot, fakeTimer);
	} finally {
		await server.close();
	}

	if (installFakeTimer) {
		(fakeTimer as InstalledClock).uninstall();
	}
};

export const withHttpsServer = generateHttpsHook;

// TODO: Remove this when `create-test-server` supports custom listen.
export const withSocketServer: Macro<[RunTestWithSocket]> = async (t, run) => {
	const socketPath = tempy.file({extension: 'socket'});

	const server = http.createServer((request, response) => {
		server.emit(request.url!, request, response);
	}) as ExtendedHttpServer;

	server.socketPath = socketPath;

	// @ts-expect-error TypeScript doesn't accept `callback` with no arguments
	await promisify<any>(server.listen.bind(server))(socketPath);

	try {
		await run(t, server);
	} finally {
		await promisify(server.close.bind(server))();
	}
};
