import test from 'ava';
import withServer from './helpers/with-server.js';

// RFC 9110 section 6.4.1: these responses cannot contain content.
for (const {method, statusCode} of [{method: 'HEAD', statusCode: 200}, {method: 'GET', statusCode: 204}, {method: 'GET', statusCode: 205}, {method: 'GET', statusCode: 304}]) {
	for (const responseType of ['text', 'json'] as const) {
		test(`disabled decompression preserves empty ${responseType} body for ${method} ${statusCode}`, withServer, async (t, server, got) => {
			server.all('/', (_request, response) => {
				response.writeHead(statusCode, {'content-encoding': 'gzip'});
				response.end();
			});

			const response = responseType === 'text'
				? await got('', {method, responseType: 'text', decompress: false})
				: await got('', {method, responseType: 'json', decompress: false});

			t.is(response.body, '');
			t.is(response.rawBody.byteLength, 0);
			t.is(response.headers['content-encoding'], 'gzip');
		});
	}

	test(`bodyless ${method} ${statusCode} preserves buffer output with decompression disabled`, withServer, async (t, server, got) => {
		server.all('/', (_request, response) => {
			response.writeHead(statusCode, {'content-encoding': 'gzip, br'}).end();
		});

		const response = await got('', {
			method, responseType: 'buffer', decompress: false, resolveBodyOnly: false,
		});
		t.true(response.body instanceof Uint8Array);
		t.is(response.body.byteLength, 0);
	});

	test(`bodyless ${method} ${statusCode} resolves empty text and exposes it to hooks`, withServer, async (t, server, got) => {
		server.all('/', (_request, response) => {
			response.writeHead(statusCode, {'content-encoding': 'gzip, br'}).end();
		});

		let hookCalls = 0;
		const body = await got('', {
			method,
			decompress: false,
			resolveBodyOnly: true,
			hooks: {
				afterResponse: [response => {
					hookCalls++;
					t.is(response.body, '');
					return response;
				}],
			},
		});

		t.is(body, '');
		t.is(hookCalls, 1);
	});
}

for (const responseType of ['text', 'json', 'buffer'] as const) {
	test(`empty GET 200 compressed content remains bytes for ${responseType}`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.writeHead(200, {'content-encoding': 'gzip'}).end();
		});

		const response = responseType === 'text'
			? await got('', {responseType: 'text', decompress: false})
			: (responseType === 'json'
				? await got('', {responseType: 'json', decompress: false})
				: await got('', {responseType: 'buffer', decompress: false}));
		t.true(ArrayBuffer.isView(response.body));
		t.is(response.rawBody.byteLength, 0);
	});
}
