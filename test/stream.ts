import {promisify} from 'util';
import fs = require('fs');
import {PassThrough as PassThroughStream} from 'stream';
import stream = require('stream');
import test from 'ava';
import {Handler} from 'express';
import toReadableStream = require('to-readable-stream');
import getStream = require('get-stream');
import pEvent = require('p-event');
import FormData = require('form-data');
import is from '@sindresorhus/is';
import got, {RequestError} from '../source';
import withServer from './helpers/with-server';

const pStreamPipeline = promisify(stream.pipeline);

const defaultHandler: Handler = (_request, response) => {
	response.writeHead(200, {
		unicorn: 'rainbow',
		'content-encoding': 'gzip'
	});
	response.end(Buffer.from('H4sIAAAAAAAA/8vPBgBH3dx5AgAAAA==', 'base64')); // 'ok'
};

const redirectHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/'
	});
	response.end();
};

const postHandler: Handler = async (request, response) => {
	await pStreamPipeline(request, response);
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

test('throws on write if body is specified', withServer, (t, server, got) => {
	server.post('/', postHandler);

	const streams = [
		got.stream.post({body: 'wow'}),
		got.stream.post({json: {}}),
		got.stream.post({form: {}})
	];

	for (const stream of streams) {
		t.throws(() => {
			stream.end('wow');
		}, {
			message: 'The payload has been already provided'
		});

		stream.destroy();
	}
});

test('does not throw if using stream and passing a json option', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	await t.notThrowsAsync(getStream(got.stream.post({json: {}})));
});

test('does not throw if using stream and passing a form option', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	await t.notThrowsAsync(getStream(got.stream.post({form: {}})));
});

test('throws on write if no payload method is present', withServer, (t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.get('');

	t.throws(() => {
		stream.end('wow');
	}, {
		message: 'The payload has been already provided'
	});

	stream.destroy();
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
	const {headers} = await pEvent(stream, 'redirect');
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
		instanceOf: got.HTTPError,
		message: 'Response code 404 (Not Found)'
	});
});

test('has error event #2', withServer, async (t, _server, got) => {
	const stream = got.stream('http://doesntexist', {prefixUrl: ''});
	await t.throwsAsync(pEvent(stream, 'response'), {code: 'ENOTFOUND'});
});

test('has response event if `options.throwHttpErrors` is false', withServer, async (t, server, got) => {
	server.get('/', errorHandler);

	const {statusCode} = await pEvent(got.stream({throwHttpErrors: false}), 'response');
	t.is(statusCode, 404);
});

test('accepts `options.body` as a Stream', withServer, async (t, server, got) => {
	server.post('/', postHandler);

	const stream = got.stream.post({body: toReadableStream('wow')});
	t.is(await getStream(stream), 'wow');
});

test('redirect response contains old url', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/redirect', redirectHandler);

	const {requestUrl} = await pEvent(got.stream('redirect'), 'response');
	t.is(requestUrl, `${server.url}/redirect`);
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
		await pStreamPipeline(
			got.stream(''),
			response
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
		await pStreamPipeline(
			request,
			got.stream(''),
			response
		);
	});

	const {foo}: {foo: string} = await got('proxy', {
		headers: {
			foo: 'bar'
		}
	}).json();
	t.is(foo, 'bar');
});

test('skips proxying headers after server has sent them already', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		response.writeHead(200);

		await pStreamPipeline(
			got.stream(''),
			response
		);
	});

	const {headers} = await got('proxy');
	t.is(headers.unicorn, undefined);
});

test('throws when trying to proxy through a closed stream', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	const promise = getStream(stream);

	stream.once('data', () => {
		t.throws(() => {
			stream.pipe(new PassThroughStream());
		}, {
			message: 'Failed to pipe. The response has been emitted already.'
		});
	});

	await promise;
});

test('proxies `content-encoding` header when `options.decompress` is false', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);
	server.get('/proxy', async (_request, response) => {
		await pStreamPipeline(
			got.stream({decompress: false}),
			response
		);
	});

	const {headers} = await got('proxy');
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
		await getStream(
			stream.pipeline(
				got.stream(''),
				got.stream.put('post'),
				() => {}
			)
		);
	});
});

test('no unhandled body stream errors', async t => {
	const form = new FormData();
	form.append('upload', fs.createReadStream('/bin/sh'));

	await t.throwsAsync(got.post(`https://offlinesite${Date.now()}.com`, {
		form
	}), {
		code: 'ENOTFOUND'
	});
});

test('works with pipeline', async t => {
	await t.throwsAsync(pStreamPipeline(
		new stream.Readable({
			read() {
				this.push(null);
			}
		}),
		got.stream.put('http://localhost:7777')
	), {
		instanceOf: RequestError,
		message: 'connect ECONNREFUSED 127.0.0.1:7777'
	});
});

test('errors have body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'foo=bar');
		response.end('yay');
	});

	const error = await t.throwsAsync<RequestError>(getStream(got.stream('', {
		cookieJar: {
			setCookie: async (_, __) => {
				throw new Error('snap');
			},
			getCookieString: async _ => ''
		}
	})));

	t.is(error.message, 'snap');
	t.is(error.response?.body, 'yay');
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
	await promisify(stream.pipeline)(gotStream, receiver);

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

if (process.versions.node.split('.')[0] <= '12') {
	test('does not emit end event on error', withServer, async (t, server, got) => {
		server.get('/', infiniteHandler);

		await t.notThrowsAsync(new Promise((resolve, reject) => {
			got.stream({
				timeout: 100,
				hooks: {
					beforeError: [
						async error => {
							await new Promise(resolve => {
								setTimeout(resolve, 50);
							});

							return error;
						}
					]
				}
			}).once('end', () => {
				reject(new Error('Stream has ended before erroring'));
			}).once('error', resolve).resume();
		}));
	});
}
