import {ClientRequest} from 'http';
import {Transform as TransformStream} from 'stream';
import test from 'ava';
import withServer from './helpers/with-server';

test('should emit request event as promise', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.statusCode = 200;
		response.end();
	});

	await got('').json().on('request', request => {
		t.true(request instanceof ClientRequest);
	});
});

test('should emit response event as promise', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.statusCode = 200;
		response.end();
	});

	await got('').json().on('response', response => {
		t.true(response instanceof TransformStream);
		t.true(response.readable);
		t.is(response.statusCode, 200);
	});
});
