import {Server} from 'http';
import {TestServer} from 'create-test-server';
import * as lolex from 'lolex';
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

export type InstalledClock = ReturnType<typeof lolex.install>;
export type GlobalClock = InstalledClock | lolex.NodeClock;
