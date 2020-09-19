import {ReadStream} from 'fs';
import {ClientRequest, IncomingMessage} from 'http';
import test from 'ava';
import {Response, CancelError} from '../source';
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

let p: any;
process.on('unhandledRejection', (_error, promise) => {
	console.log(promise === p, p, promise);
});

test.only('promise.json() can be called before a file stream body is open', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.end();
		});
	});

	// @ts-ignore @types/node has wrong types.
	const body = new ReadStream('', {
		fs: {
			open: () => {},
			read: () => {},
			close: () => {}
		}
	});

	const promise = got({body});
	// @ts-ignore
	promise.asdf = 123;
	p = promise;
	let jsonPromise: any;
	t.notThrows(() => {
		jsonPromise = promise.json()
	});

	promise.cancel();

	await t.throwsAsync(promise, {instanceOf: CancelError});;
	await t.throwsAsync(jsonPromise, {instanceOf: CancelError});;
});
