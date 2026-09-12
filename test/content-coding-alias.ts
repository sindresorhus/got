import {gzipSync} from 'node:zlib';
import test from 'ava';
import withServer from './helpers/with-server.js';

for (const encoding of ['x-gzip', 'X-GZip', 'gzip, x-gzip', 'x-gzip, gzip']) {
	test(`decodes the standard ${encoding} content coding alias`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.setHeader('content-encoding', encoding);
			const payload = gzipSync('decoded payload');
			response.end(encoding.includes(',') ? gzipSync(payload) : payload);
		});

		t.is(await got('').text(), 'decoded payload');
	});
}

test('the compressed alias retains its compressed bytes when decompression is disabled', withServer, async (t, server, got) => {
	const payload = gzipSync('encoded payload');
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'x-gzip');
		response.end(payload);
	});

	const response = await got('', {decompress: false});

	t.deepEqual(response.rawBody, new Uint8Array(payload));
	t.deepEqual(response.body, new Uint8Array(payload));
	t.is(response.headers['content-encoding'], 'x-gzip');
});
