import type {Server} from 'node:http';
import type {TestServer} from 'create-test-server';

export type ExtendedHttpServer = {
	socketPath: string;
} & Server;

export type ExtendedTestServer = {
	hostname: string;
	sslHostname: string;
} & TestServer;

// https://github.com/sinonjs/fake-timers/pull/386
export type InstalledClock = any;
export type GlobalClock = any;
