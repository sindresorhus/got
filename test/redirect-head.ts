import test from 'ava';
import withServer from './helpers/with-server.js';

for (const statusCode of [301, 302, 303, 307, 308]) {
	for (const methodRewriting of [false, true]) {
		test(`HEAD stays HEAD after ${statusCode} with methodRewriting ${methodRewriting}`, withServer, async (t, server, got) => {
			const methods: string[] = [];
			server.use((request, response) => {
				methods.push(request.method);
				if (request.url === '/start') {
					response.writeHead(statusCode, {location: '/end'}).end();
					return;
				}

				response.end('representation');
			});

			const response = await got.head('start', {methodRewriting});

			t.deepEqual(methods, ['HEAD', 'HEAD']);
			t.is(response.body, '');
			t.is(response.request.options.method, 'HEAD');
		});
	}
}
