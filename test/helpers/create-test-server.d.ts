declare module 'create-test-server' {
	import {TestServer} from './types';

	function createTestServer(options: any): Promise<TestServer>;

	export = createTestServer;
}
