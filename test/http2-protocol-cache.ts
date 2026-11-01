import assert from 'node:assert/strict';
import got from '../source/index.js';
import test from './helpers/test.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';

for (const [offeredProtocols, differentProtocols] of [
	[['h2', 'http/1.1'], ['h2,http/1.1']],
	[['private,protocol', 'h2'], ['private', 'protocol,h2']],
] satisfies Array<[string[], string[]]>) {
	test(`HTTP/2 ALPN cache keeps protocol boundaries for ${offeredProtocols.join(',')}`, async t => {
		let requests = 0;
		const server = await createHttp2TestServer(stream => {
			requests++;
			stream.respond({':status': 200});
			stream.end('h2');
		});
		t.after(async () => {
			await server.close();
		});
		const options = {
			http2: true,
			agent: {http2: false as const},
			retry: {limit: 0},
			https: {rejectUnauthorized: false},
		};
		assert.strictEqual((await got(server.url, {
			...options,
			https: {...options.https, alpnProtocols: offeredProtocols},
		})).body, 'h2');
		await assert.rejects(got(server.url, {
			...options,
			https: {...options.https, alpnProtocols: differentProtocols},
		}), {code: 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL'});
		assert.strictEqual(requests, 1);
	});
}
