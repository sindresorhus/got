import type {Buffer} from 'node:buffer';

declare module 'create-test-server' {
	import type {Express} from 'express';

	function createTestServer(options: unknown): Promise<createTestServer.TestServer>;

	export = createTestServer;

	namespace createTestServer {
		export type TestServer = {
			caCert: string | Buffer | Array<string | Buffer>;
			port: number;
			url: string;
			sslPort: number;
			sslUrl: string;

			close: () => Promise<void>;
		} & Express;
	}
}
