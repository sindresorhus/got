import {Express} from 'express';
import * as lolex from 'lolex';
import {Got} from '../../source';

export interface ExtendedGot extends Got {
	secure: Got;
}

export interface TestServer extends Express {
	caCert: any;
	port: number;
	url: string;
	sslPort: number;
	sslUrl: string;

	close(): Promise<void>;
}

export interface ExtendedTestServer extends TestServer {
	hostname: string;
	sslHostname: string;
}

export type InstalledClock = ReturnType<typeof lolex.install>;
export type GlobalClock = InstalledClock | lolex.NodeClock;
