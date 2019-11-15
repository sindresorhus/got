declare module 'create-test-server' {
	import {Express} from 'express';

	function createTestServer(options: any): Promise<createTestServer.TestServer>;

	export = createTestServer;

	namespace createTestServer {
		export interface TestServer extends Express {
			caCert: any;
			port: number;
			url: string;
			sslPort: number;
			sslUrl: string;

			close(): Promise<void>;
		}
	}
}
