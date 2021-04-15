import {Server} from 'http';
import {TestServer} from 'create-test-server';
import FakeTimers from '@sinonjs/fake-timers';

export interface ExtendedHttpServer extends Server {
	socketPath: string;
}

export interface ExtendedTestServer extends TestServer {
	hostname: string;
	sslHostname: string;
}

export type InstalledClock = ReturnType<typeof FakeTimers.install>;
export type GlobalClock = InstalledClock | FakeTimers.NodeClock;
