import FakeTimers = require('@sinonjs/fake-timers');
import {createServer, HttpServerOptions, HttpsServerOptions, ExtendedHttpServer, HttpSocketServerOptions, ExtendedHttpsServer, ExtendedHttpSocketServer} from './http-server';
import test = require('ava');
import got, {InstanceDefaults, Got} from '../../source';

type BaseHookOptions = {
	installFakeTimer?: boolean;
	installBodyParser?: boolean;
};
type HookOptions = BaseHookOptions & HttpServerOptions | BaseHookOptions & HttpsServerOptions | BaseHookOptions & HttpSocketServerOptions;

type RunTestWithHttpServer = (t: test.ExecutionContext, server: ExtendedHttpServer, got: Got, clock?: FakeTimers.InstalledClock) => Promise<void> | void;
type RunTestWithHttpsServer = (t: test.ExecutionContext, server: ExtendedHttpsServer, got: Got, clock?: FakeTimers.InstalledClock) => Promise<void> | void;
type RunTestWithHttpSocketServer = (t: test.ExecutionContext, server: ExtendedHttpSocketServer, got: Got, clock?: FakeTimers.InstalledClock) => Promise<void> | void;
type RunTestWithServer = RunTestWithHttpServer | RunTestWithHttpsServer | RunTestWithHttpSocketServer;

export interface WithServerFunction {
	(options: BaseHookOptions & HttpServerOptions): test.Macro<[RunTestWithHttpServer]>;
	(options: BaseHookOptions & HttpsServerOptions): test.Macro<[RunTestWithHttpsServer]>;
	(options: BaseHookOptions & HttpSocketServerOptions): test.Macro<[RunTestWithHttpSocketServer]>;
}

export const withServer: WithServerFunction = (options: HookOptions): test.Macro<[RunTestWithServer]> => async (t, run) => {
	const fakeTimer = options.installFakeTimer ? FakeTimers.install() : undefined;

	// TODO remove this if is possible
	let server;
	if (options.protocol === 'https') {
		server = await createServer(options);
	} else if (options.protocol === 'socket') {
		server = await createServer(options);
	} else {
		server = await createServer(options);
	}

	const gotOptions: InstanceDefaults = {
		// @ts-expect-error Augmenting for test detection
		avaTest: t.title,
		handlers: [
			(options, next) => {
				const result = next(options);

				fakeTimer?.tick(0);

				// @ts-expect-error FIXME: Incompatible union type signatures
				result.on('response', () => {
					fakeTimer?.tick(0);
				});

				return result;
			}
		]
	};

	let preparedGot;
	if (server.protocol === 'https') {
		preparedGot = got.extend({
			prefixUrl: server.url,
			https: {
				certificateAuthority: server.caCert,
				rejectUnauthorized: true
			},
			...gotOptions
		});
	} else if (server.protocol === 'socket') {
		preparedGot = got.extend({...gotOptions});
	} else {
		preparedGot = got.extend({prefixUrl: server.url, ...gotOptions});
	}

	try {
		// TODO remove the `any` cast
		await run(t, server as any, preparedGot, fakeTimer);
	} finally {
		await server.close();
	}

	fakeTimer?.uninstall();
};

type Except<ObjectType, KeysType extends keyof ObjectType> = Pick<ObjectType, Exclude<keyof ObjectType, KeysType>>;
export const withHttpServer = (options?: Except<BaseHookOptions & HttpServerOptions, 'protocol'>): test.Macro<[RunTestWithHttpServer]> => withServer({protocol: 'http', ...options});
export const withHttpsServer = (options?: Except<BaseHookOptions & HttpsServerOptions, 'protocol'>): test.Macro<[RunTestWithHttpsServer]> => withServer({protocol: 'https', ...options});
export const withHttpSocketServer = (options?: Except<BaseHookOptions & HttpSocketServerOptions, 'protocol'>): test.Macro<[RunTestWithHttpSocketServer]> => withServer({protocol: 'socket', ...options});
export const withHttpServerAndFakeTimers = (options?: Except<BaseHookOptions & HttpServerOptions, 'protocol' | 'installFakeTimer'>): test.Macro<[RunTestWithHttpServer]> => withServer({protocol: 'http', installFakeTimer: true, ...options});
export const withHttpServerWithBodyParser = (options?: Except<BaseHookOptions & HttpServerOptions, 'protocol' | 'installBodyParser'>): test.Macro<[RunTestWithHttpServer]> => withServer({protocol: 'http', installBodyParser: true, ...options});

export type FakeTimer = FakeTimers.InstalledClock;
