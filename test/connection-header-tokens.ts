import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import getStream from 'get-stream';
import {auto} from '../source/core/utils/http2-client.js';
import createHttp2TestServer from './helpers/create-http2-test-server.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('response forwarding parses repeated connection nominations with case and whitespace', withServer, async (_t, server, got) => {
	server.get('/upstream', (_request, response) => {
		response.setHeader('Connection', ['keep-alive, X-One', ', , X-Two	']);
		response.setHeader('Proxy-Connection', '	X-Three ,');
		response.setHeader('X-One', 'private one');
		response.setHeader('X-Two', 'private two');
		response.setHeader('X-Three', 'private three');
		response.setHeader('X-Public', 'retained');
		response.end('forwarded');
	});
	server.get('/proxy', (_request, response) => {
		got.stream('upstream').on('error', error => response.destroy(error)).pipe(response);
	});
	const response = await got('proxy');
	assert.strictEqual(response.body, 'forwarded');
	assert.strictEqual(response.headers['x-public'], 'retained');
	for (const name of ['x-one', 'x-two', 'x-three']) {
		assert.strictEqual(response.headers[name], undefined);
	}
});

test('HTTP/2 request filtering uses the same connection nomination grammar', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		stream.respond({':status': 200});
		stream.end(JSON.stringify(headers));
	});
	t.after(server.close);
	const request = await auto(server.url, {
		rejectUnauthorized: false,
		headers: {
			connection: ['keep-alive, X-One', ', , X-Two	'],
			'Proxy-Connection': ['	X-Three ,'],
			'X-One': 'private one',
			'X-Two': 'private two',
			'X-Three': 'private three',
			'X-Public': 'retained',
		},
	});
	const incoming = once(request, 'response');
	request.end();
	const [response] = await incoming;
	const headers = JSON.parse(await getStream(response));
	assert.strictEqual(headers['x-public'], 'retained');
	for (const name of ['connection', 'proxy-connection', 'x-one', 'x-two', 'x-three']) {
		assert.strictEqual(headers[name], undefined);
	}
});

test('piped request headers ignore undefined connection values and filter repeated nominations', withServer, async (_t, server, got) => {
	server.post('/target', async (request, response) => {
		response.end(JSON.stringify({body: await getStream(request), headers: request.headers}));
	});
	const source = Object.assign(Readable.from(['payload']), {
		headers: {
			connection: undefined,
			'Proxy-Connection': ['X-One, ,\tX-Two', ' X-Three,'],
			'X-One': 'private one',
			'X-Two': 'private two',
			'X-Three': 'private three',
			'X-Public': 'retained',
		},
	});
	const request = got.stream.post('target', {copyPipedHeaders: true});
	source.pipe(request);
	const {body, headers} = JSON.parse(await getStream(request));
	assert.strictEqual(body, 'payload');
	assert.strictEqual(headers['x-public'], 'retained');
	for (const name of ['proxy-connection', 'x-one', 'x-two', 'x-three']) {
		assert.strictEqual(headers[name], undefined);
	}
});

test('HTTP/2 header and trailer filtering preserves numeric connection nominations', async t => {
	const server = await createHttp2TestServer((stream, headers) => {
		let trailers: Record<string, unknown> | undefined;
		stream.on('trailers', received => {
			trailers = received;
		});
		stream.resume();
		stream.once('end', () => {
			stream.respond({':status': 200});
			stream.end(JSON.stringify({headers, trailers}));
		});
	});
	t.after(server.close);
	const request = await auto(server.url, {rejectUnauthorized: false});
	request.setHeader('connection', 0);
	request.setHeader('0', 'private header');
	request.addTrailers({'proxy-connection': 1, 1: 'private trailer', 'x-public': 'retained'});
	const incoming = once(request, 'response');
	request.end();
	const [response] = await incoming;
	const {headers, trailers} = JSON.parse(await getStream(response));
	assert.strictEqual(headers['0'], undefined);
	assert.strictEqual(headers.connection, undefined);
	assert.strictEqual(trailers['1'], undefined);
	assert.strictEqual(trailers['proxy-connection'], undefined);
	assert.strictEqual(trailers['x-public'], 'retained');
});
