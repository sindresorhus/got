import {ClientRequest, IncomingMessage} from 'http';
import test from 'ava';
import {Response} from '../source';
import withServer from './helpers/with-server';

test('emits request event as promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end('null');
	});

	await got('').json().on('request', (request: ClientRequest) => {
		t.true(request instanceof ClientRequest);
	});
});

test('emits response event as promise', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end('null');
	});

	await got('').json().on('response', (response: Response) => {
		t.true(response instanceof IncomingMessage);
		t.true(response.readable);
		t.is(response.statusCode, 200);
		t.is(response.ip, '127.0.0.1');
	});
});

test('returns buffer on compressed response', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end();
	});

	const {body} = await got({decompress: false});
	t.true(Buffer.isBuffer(body));
});
