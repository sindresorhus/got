declare module 'create-test-server' {
	import {Express} from 'express';

	function createTestServer(options: unknown): Promise<createTestServer.TestServer>;

	export = createTestServer;

	namespace createTestServer {
		export interface TestServer extends Express {
			caCert: string | Buffer | Array<string | Buffer>;
			port: number;
			url: string;
			sslPort: number;
			sslUrl: string;

			close(): Promise<void>;
		}
	}
}
