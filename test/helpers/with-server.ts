import {URL} from 'url';
import createTestServer from 'create-test-server';

export default async (t, run) => {
	const server = await createTestServer();

	server.hostname = (new URL(server.url)).hostname;

	try {
		await run(t, server);
	} finally {
		await server.close();
	}
};
