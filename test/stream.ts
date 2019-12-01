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
import got from '../source';
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

	t.throws(() => {
		got.stream.post({body: 'wow'}).end('wow');
	}, 'Got\'s stream is not writable when the `body`, `json` or `form` option is used');

	t.throws(() => {
		got.stream.post({json: {}}).end('wow');
	}, 'Got\'s stream is not writable when the `body`, `json` or `form` option is used');

	t.throws(() => {
		got.stream.post({form: {}}).end('wow');
	}, 'Got\'s stream is not writable when the `body`, `json` or `form` option is used');
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

	t.throws(() => {
		got.stream.get('').end('wow');
	}, 'The `GET` method cannot be used with a body');
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
		}, 'Failed to pipe. The response has been emitted already.');
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

test('destroying got.stream() cancels the request', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	const stream = got.stream('');
	const request = await pEvent(stream, 'request');
	stream.destroy();
	t.truthy(request.aborted);
});

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
