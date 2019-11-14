declare module 'create-test-server' {
	import {Express} from 'express';

	export interface TestServer extends Express {
		caCert: any;
		port: number;
		url: string;
		sslPort: number;
		sslUrl: string;

		close(): Promise<void>;
	}

	function createTestServer(options: any): Promise<TestServer>;

	export = createTestServer;
}
