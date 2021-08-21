import {Server} from 'http';
// @ts-expect-error Fails to locate ../types/create-test-server/index.d.ts
import {TestServer} from 'create-test-server';

export interface ExtendedHttpServer extends Server {
	socketPath: string;
}

export interface ExtendedTestServer extends TestServer {
	hostname: string;
	sslHostname: string;
}

// https://github.com/sinonjs/fake-timers/pull/386
export type InstalledClock = any;
export type GlobalClock = any;
