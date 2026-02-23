declare module 'create-test-server' {
	import type {Express} from 'express';

	function createTestServer(options: unknown): Promise<createTestServer.TestServer>;

	export = createTestServer;

	namespace createTestServer {
		export type TestServer = {
			caCert: string | Uint8Array | Array<string | Uint8Array>;
			port: number;
			url: string;
			sslPort: number;
			sslUrl: string;

			close: () => Promise<void>;
		} & Express;
	}
}
