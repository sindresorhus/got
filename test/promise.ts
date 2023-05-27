import {Buffer} from 'node:buffer';
import {ReadStream} from 'node:fs';
import {ClientRequest, IncomingMessage} from 'node:http';
import test from 'ava';
import {type Response, CancelError} from '../source/index.js';
import withServer from './helpers/with-server.js';

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
		t.false(response.readable);
		t.is(response.statusCode, 200);
		t.true(response.ip === '127.0.0.1' || response.ip === '::1');
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

test('no unhandled `The server aborted pending request` rejection', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.write('asdf');

		setTimeout(() => {
			response.end();
		}, 100);
	});

	await t.throwsAsync(got(''));
});

test('promise.json() can be called before a file stream body is open', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.end('""');
		});
	});

	// @ts-expect-error @types/node has wrong types.
	const body = new ReadStream('', {
		fs: {
			open() {},
			read() {},
			close() {},
		},
	});

	const promise = got({body});
	const checks = [
		t.throwsAsync(promise, {
			instanceOf: CancelError,
			code: 'ERR_CANCELED',
		}),
		t.throwsAsync(promise.json(), {
			instanceOf: CancelError,
			code: 'ERR_CANCELED',
		}),
	];

	promise.cancel();

	await Promise.all(checks);
});

test('promise.json() does not fail when server returns an error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('{}');
	});

	const promise = got('', {throwHttpErrors: false});
	await t.notThrowsAsync(promise.json());
});
