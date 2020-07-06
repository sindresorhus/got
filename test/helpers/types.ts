import {Server} from 'http';
import {TestServer} from 'create-test-server';
import * as FakeTimers from '@sinonjs/fake-timers';
import {Got} from '../../source';

export interface ExtendedGot extends Got {
	secure: Got;
}

export interface ExtendedHttpServer extends Server {
	socketPath: string;
}

export interface ExtendedTestServer extends TestServer {
	hostname: string;
	sslHostname: string;
}

export type InstalledClock = ReturnType<typeof FakeTimers.install>;
export type GlobalClock = InstalledClock | FakeTimers.NodeClock;
