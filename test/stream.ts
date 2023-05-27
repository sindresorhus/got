import process from 'node:process';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import {Agent as HttpAgent} from 'node:http';
import stream, {Readable as ReadableStream, Writable} from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import {Readable as Readable2} from 'readable-stream';
import test from 'ava';
import type {Handler} from 'express';
import getStream from 'get-stream';
import {pEvent} from 'p-event';
import FormData from 'form-data';
import is from '@sindresorhus/is';
import delay from 'delay';
import got, {HTTPError, RequestError} from '../source/index.js';
import withServer from './helpers/with-server.js';

const defaultHandler: Handler = (_request, response) => {
	response.writeHead(200, {
		unicorn: 'rainbow',
		'content-encoding': 'gzip',
	});
	response.end(Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64')); // 'ok'
};

const redirectHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/',
	});
	response.end();
};

const postHandler: Handler = async (request, response) => {
	await streamPipeline(request, response);
};

const errorHandler: Handler = (_request, response) => {
	response.statusCode = 404;
	response.end();
};

const headersHandler: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

const infiniteHandler: Handler = (_request, response) => {
	response.write('foobar');
};

test('reusedSocket getter', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const agent = new HttpAgent({keepAlive: true});

	const stream = got.stream('', {agent: {http: agent}});
	t.is(stream.reusedSocket, undefined);

	await pEvent(stream, 'response');

	stream.resume();
	await pEvent(stream, 'end');

	t.false(stream.reusedSocket);

	const secondStream = got.stream('', {agent: {http: agent}});
	secondStream.resume();
	await pEvent(secondStream, 'end');

	t.true(secondStream.reusedSocket);
});

test('`options.responseType` is ignored', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.notThrowsAsync(getStream(got.stream({responseType: 'json'})));
});

test('returns readable stream', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const data = await getStream(got.stream(''));
	t.is(data, 'ok');
});

test('returns writeable stream', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post('');
	const promise = getStream(stream);
	stream.end('wow');

	t.is(await promise, 'wow');
});

test('does not throw if using stream and passing a json option', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	await t.notThrowsAsync(getStream(got.stream.post({json: {}})));
});

test('does not throw if using stream and passing a form option', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	await t.notThrowsAsync(getStream(got.stream.post({form: {}})));
});

test('has request event', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	const request = await pEvent(stream, 'request');
	t.truthy(request);
	t.is(request.method, 'GET');

	await getStream(stream);
});

test('has redirect event', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const stream = got.stream('redirect');
	const [, {headers}] = await pEvent(stream, 'redirect', {multiArgs: true});
	t.is(headers.location, '/');

	await getStream(stream);
});

test('has response event', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const {statusCode} = await pEvent(got.stream(''), 'response');
	t.is(statusCode, 200);
});

test('has error event', withServer, async (t, server, got) => {
	server.get('/', errorHandler);

	const stream = got.stream('');
	await t.throwsAsync(pEvent(stream, 'response'), {
		instanceOf: HTTPError,
		message: 'Response code 404 (Not Found)',
	});
});

test('has error event #2', async t => {
	const stream = got.stream('http://doesntexist');
	try {
		await pEvent(stream, 'response');
	} catch (error: any) {
		t.regex(error.code, /ENOTFOUND|EAI_AGAIN/);
	}
});

test('has response event if `options.throwHttpErrors` is false', withServer, async (t, server, got) => {
	server.get('/', errorHandler);

	const {statusCode} = await pEvent(got.stream({throwHttpErrors: false}), 'response');
	t.is(statusCode, 404);
});

test('accepts `options.body` as a Stream', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({body: ReadableStream.from('wow')});
	t.is(await getStream(stream), 'wow');
});

test('redirect response contains old url', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const {requestUrl} = await pEvent(got.stream('redirect'), 'response');
	t.is(requestUrl.toString(), `${server.url}/redirect`);
});

test('check for pipe method', withServer, (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	t.true(is.function_(stream.pipe));
	t.true(is.function_(stream.on('foobar', () => {}).pipe));

	stream.destroy();
});

test('piping works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is(await getStream(got.stream('')), 'ok');
	t.is(await getStream(got.stream('').on('foobar', () => {})), 'ok');
});

test('proxying headers works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		await streamPipeline(
			got.stream(''),
			response,
		);
	});

	const {headers, body} = await got('proxy');
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], undefined);
	t.is(body, 'ok');
});

test('piping server request to Got proxies also headers', withServer, async (t, server, got) => {
	server.get('/', headersHandler);
	server.get('/proxy', async (request, response) => {
		await streamPipeline(
			request,
			got.stream(''),
			response,
		);
	});

	const {foo}: {foo: string} = await got('proxy', {
		headers: {
			foo: 'bar',
		},
	}).json();
	t.is(foo, 'bar');
});

test('skips proxying headers after server has sent them already', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		response.writeHead(200);

		await streamPipeline(
			got.stream(''),
			response,
		);
	});

	const {headers} = await got('proxy');
	t.is(headers.unicorn, undefined);
});

test('proxies `content-encoding` header when `options.decompress` is false', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		await streamPipeline(
			got.stream({decompress: false}),
			response,
		);
	});

	const {headers} = await got('proxy', {decompress: false});
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['content-encoding'], 'gzip');
});

{
	const nodejsMajorVersion = Number(process.versions.node.split('.')[0]);
	const testFn = nodejsMajorVersion < 14 ? test.failing : test;

	testFn('destroying got.stream() destroys the request - `request` event', withServer, async (t, server, got) => {
		server.get('/', defaultHandler);

		const stream = got.stream('');
		const request = await pEvent(stream, 'request');
		stream.destroy();
		t.truthy(request.destroyed);
	});

	testFn('destroying got.stream() destroys the request - `response` event', withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.write('hello');
		});

		const stream = got.stream('');
		const request = await pEvent(stream, 'request');
		await pEvent(stream, 'response');
		stream.destroy();
		t.truthy(request.destroyed);
	});
}

test('piping to got.stream.put()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.put('/post', postHandler);

	await t.notThrowsAsync(async () => {
		const stream = got.stream.put('post');

		await streamPipeline(
			got.stream(''),
			stream,
		);

		await getStream(stream);
	});
});

// See https://github.com/nodejs/node/issues/35237
// eslint-disable-next-line ava/no-skip-test
test.skip('no unhandled body stream errors', async t => {
	const body = new FormData();
	body.append('upload', fs.createReadStream('/bin/sh'));

	await t.throwsAsync(got.post(`https://offlinesite${Date.now()}.com`, {
		body,
	}), {
		code: 'ENOTFOUND',
	});
});

test('works with pipeline', async t => {
	await t.throwsAsync(streamPipeline(
		new ReadableStream({
			read() {
				this.push(null);
			},
		}),
		got.stream.put('http://localhost:7777'),
	), {
		instanceOf: RequestError,
		message: /^connect ECONNREFUSED (127\.0\.0\.1|::1):7777$/,
	});
});

test('errors have body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'foo=bar');
		response.end('yay');
	});

	const error = await t.throwsAsync<RequestError>(getStream(got.stream('', {
		cookieJar: {
			async setCookie() {
				throw new Error('snap');
			},
			getCookieString: async () => '',
		},
	})));

	t.is(error?.message, 'snap');
	t.is(error?.response?.body, 'yay');
});

test('pipe can send modified headers', withServer, async (t, server, got) => {
	server.get('/foobar', (_request, response) => {
		response.setHeader('foo', 'bar');
		response.end();
	});

	server.get('/', (_request, response) => {
		got.stream('foobar').on('response', response => {
			response.headers.foo = 'boo';
		}).pipe(response);
	});

	const {headers} = await got('');
	t.is(headers.foo, 'boo');
});

test('the socket is alive on a successful pipeline', withServer, async (t, server, got) => {
	const payload = 'ok';

	server.get('/', (_request, response) => {
		response.end(payload);
	});

	const gotStream = got.stream('');
	t.is(gotStream.socket, undefined);

	const receiver = new stream.PassThrough();
	await streamPipeline(gotStream, receiver);

	t.is(await getStream(receiver), payload);
	t.truthy(gotStream.socket);
	t.false(gotStream.socket!.destroyed);
});

test('async iterator works', withServer, async (t, server, got) => {
	const payload = 'ok';

	server.get('/', (_request, response) => {
		response.end(payload);
	});

	const gotStream = got.stream('');
	const chunks = [];

	for await (const chunk of gotStream) {
		chunks.push(chunk);
	}

	t.is(Buffer.concat(chunks).toString(), payload);
});

test('destroys only once', async t => {
	const stream = got.stream('https://example.com');
	stream.destroy();
	stream.destroy(new Error('oh no'));

	let errored = false;

	stream.once('error', () => {
		errored = true;
	});

	await delay(1);

	t.false(errored);
});

test('does not accept unreadable stream as body', withServer, async (t, server, got) => {
	server.post('/', (_request, _response) => {});

	const body = new ReadableStream();
	body.push(null);
	body.resume();

	await pEvent(body, 'end');

	const request = got.post({body});

	await t.throwsAsync(request);

	// TODO: Add assert message above.
});

test('accepts readable-stream as body', withServer, async (t, server, got) => {
	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const body = new Readable2({
		read() {
			this.push('ok');
			this.push(null);
		},
	});

	const response = await got.post({
		// We need to cast body as any,
		// because @types/readable-stream has incorrect types
		// and causes a lot of errors.
		body: body as any,
	});

	t.is(response.body, 'ok');
});

test('prevents `Cannot call end` error', async t => {
	const stream = got.stream('https://example.com', {
		request: () => new Writable({
			final() {},
		}) as any,
		timeout: {
			request: 1,
		},
	});

	const error: RequestError = await pEvent(stream, 'error');
	t.is(error.code, 'ETIMEDOUT');
});

if (Number.parseInt(process.versions.node.split('.')[0]!, 10) <= 12) {
	test('does not emit end event on error', withServer, async (t, server, got) => {
		server.get('/', infiniteHandler);

		await t.notThrowsAsync(new Promise((resolve, reject) => {
			got.stream({
				timeout: {
					request: 100,
				},
				hooks: {
					beforeError: [
						async error => {
							await new Promise(resolve => {
								setTimeout(resolve, 50);
							});

							return error;
						},
					],
				},
			}).once('end', () => {
				reject(new Error('Stream has ended before erroring'));
			}).once('error', resolve).resume();
		}));
	});
}

// Test only on Linux
const testFn = process.platform === 'linux' ? test : test.skip;
testFn('it sends a body of file with size on stat = 0', withServer, async (t, server, got) => {
	server.post('/', async (request, response) => {
		response.end(await getStream(request));
	});

	const response = await got.post({
		body: fs.createReadStream('/proc/cpuinfo'),
	});

	t.truthy(response.body);
});
