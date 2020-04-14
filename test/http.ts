import test from 'ava';
import getStream = require('get-stream');
import got, {HTTPError, UnsupportedProtocolError} from '../source';
import withServer from './helpers/with-server';

test('simple request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.is((await got('')).body, 'ok');
});

test('empty response', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	t.is((await got('')).body, '');
});

test('response has `requestUrl` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/empty', (_request, response) => {
		response.end();
	});

	t.is((await got('')).requestUrl, `${server.url}/`);
	t.is((await got('empty')).requestUrl, `${server.url}/empty`);
});

test('http errors have `response` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync<HTTPError>(got(''), {instanceOf: HTTPError});
	t.is(error.response.statusCode, 404);
	t.is(error.response.body, 'not');
});

test('status code 304 doesn\'t throw', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 304;
		response.end();
	});

	const promise = got('');
	await t.notThrowsAsync(promise);
	const {statusCode, body} = await promise;
	t.is(statusCode, 304);
	t.is(body, '');
});

test('doesn\'t throw if `options.throwHttpErrors` is false', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	t.is((await got({throwHttpErrors: false})).body, 'not');
});

test('invalid protocol throws', async t => {
	await t.throwsAsync(got('c:/nope.com').json(), {
		instanceOf: UnsupportedProtocolError,
		message: 'Unsupported protocol "c:"'
	});
});

test('custom `options.encoding`', withServer, async (t, server, got) => {
	const string = 'ok';

	server.get('/', (_request, response) => {
		response.end(string);
	});

	const data = (await got({encoding: 'base64'})).body;
	t.is(data, Buffer.from(string).toString('base64'));
});

test('`options.encoding` doesn\'t affect streams', withServer, async (t, server, got) => {
	const string = 'ok';

	server.get('/', (_request, response) => {
		response.end(string);
	});

	const data = await getStream(got.stream({encoding: 'base64'}));
	t.is(data, string);
});

test('`got.stream(...).setEncoding(...)` works', withServer, async (t, server, got) => {
	const string = 'ok';

	server.get('/', (_request, response) => {
		response.end(string);
	});

	const data = await getStream(got.stream('').setEncoding('base64'));
	t.is(data, Buffer.from(string).toString('base64'));
});

test('`searchParams` option', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		t.is(request.query.recent, 'true');
		response.end('recent');
	});

	t.is((await got({searchParams: {recent: true}})).body, 'recent');
	t.is((await got({searchParams: 'recent=true'})).body, 'recent');
});

test('response contains url', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.is((await got('')).url, `${server.url}/`);
});

test('response contains got options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	{
		const options = {
			username: 'foo',
			password: 'bar'
		};

		const {options: normalizedOptions} = (await got(options)).request;

		t.is(normalizedOptions.username, options.username);
		t.is(normalizedOptions.password, options.password);
	}

	{
		const options = {
			username: 'foo'
		};

		const {options: normalizedOptions} = (await got(options)).request;

		t.is(normalizedOptions.username, options.username);
		t.is(normalizedOptions.password, '');
	}

	{
		const options = {
			password: 'bar'
		};

		const {options: normalizedOptions} = (await got(options)).request;

		t.is(normalizedOptions.username, '');
		t.is(normalizedOptions.password, options.password);
	}
});

test('socket destroyed by the server throws ECONNRESET', withServer, async (t, server, got) => {
	server.get('/', request => {
		request.socket.destroy();
	});

	await t.throwsAsync(got('', {retry: 0}), {
		code: 'ECONNRESET'
	});
});

test('the response contains timings property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {timings} = await got('');

	t.truthy(timings);
	t.true(timings.phases.total! >= 0);
});

test('throws an error if the server aborted the request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-type': 'text/plain'
		});
		response.write('chunk 1');

		setImmediate(() => {
			response.write('chunk 2');

			setImmediate(() => {
				response.destroy();
			});
		});
	});

	await t.throwsAsync(got(''), {
		message: 'The server aborted the pending request'
	});
});
