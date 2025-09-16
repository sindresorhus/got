import test from 'ava';
import withServer from './helpers/with-server.js';

test('does not decompress 304 Not Modified responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(304, {
			'content-encoding': 'gzip',
		});
		response.end();
	});

	// Should not hang even though the response has content-encoding header but no body
	const response = await got({
		throwHttpErrors: false,
		timeout: {
			request: 1000, // 1 second timeout to catch hangs
		},
	});

	t.is(response.statusCode, 304);
	t.is(response.body, '');
});

test('does not decompress 204 No Content responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(204, {
			'content-encoding': 'gzip',
		});
		response.end();
	});

	const response = await got({
		throwHttpErrors: false,
		timeout: {
			request: 1000,
		},
	});

	t.is(response.statusCode, 204);
	t.is(response.body, '');
});

test('does not decompress 205 Reset Content responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(205, {
			'content-encoding': 'gzip',
		});
		response.end();
	});

	const response = await got({
		throwHttpErrors: false,
		timeout: {
			request: 1000,
		},
	});

	t.is(response.statusCode, 205);
	t.is(response.body, '');
});

test('does not decompress HEAD responses with content-encoding header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		// HEAD responses should never have a body, regardless of status code
		response.writeHead(200, {
			'content-encoding': 'gzip',
			'content-type': 'text/plain',
			'content-length': '11', // Would be the length if it had a body
		});
		response.end();
	});

	const response = await got.head({
		throwHttpErrors: false,
		timeout: {
			request: 1000,
		},
	});

	t.is(response.statusCode, 200);
	t.is(response.body, '');
});

// Note: 1xx responses are handled specially by Node.js and typically
// don't reach user code in the same way as other status codes
