import {STATUS_CODES, Agent} from 'http';
import test from 'ava';
import {Handler} from 'express';
import {isIPv4, isIPv6} from 'net';
import nock = require('nock');
import getStream = require('get-stream');
import pEvent from 'p-event';
import got, {HTTPError, UnsupportedProtocolError, CancelableRequest, ReadError} from '../source';
import withServer from './helpers/with-server';
import os = require('os');

const IPv6supported = Object.values(os.networkInterfaces()).some(iface => iface?.some(addr => !addr.internal && addr.family === 'IPv6'));

const echoIp: Handler = (request, response) => {
	const address = request.connection.remoteAddress;
	if (address === undefined) {
		return response.end();
	}

	// IPv4 address mapped to IPv6
	response.end(address === '::ffff:127.0.0.1' ? '127.0.0.1' : address);
};

const echoBody: Handler = async (request, response) => {
	response.end(await getStream(request));
};

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

	const error = await t.throwsAsync<ReadError>(got(''), {
		message: 'The server aborted pending request'
	});

	t.truthy(error.response.retryCount);
});

test('statusMessage fallback', async t => {
	nock('http://statusMessageFallback').get('/').reply(503);

	const {statusMessage} = await got('http://statusMessageFallback', {
		throwHttpErrors: false,
		retry: 0
	});

	t.is(statusMessage, STATUS_CODES[503]);
});

test('does not destroy completed requests', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('content-encoding', 'gzip');
		response.end('');
	});

	const options = {
		agent: {
			http: new Agent({keepAlive: true})
		},
		retry: 0
	};

	const stream = got.stream(options);
	stream.resume();

	const endPromise = pEvent(stream, 'end');

	const socket = await pEvent(stream, 'socket');

	const closeListener = () => {
		t.fail('Socket has been destroyed');
	};

	socket.once('close', closeListener);

	await new Promise(resolve => {
		setTimeout(resolve, 10);
	});

	socket.off('close', closeListener);

	await endPromise;

	options.agent.http.destroy();

	t.pass();
});

if (IPv6supported) {
	test('IPv6 request', withServer, async (t, server) => {
		server.get('/ok', echoIp);

		const response = await got(`http://[::1]:${server.port}/ok`);

		t.is(response.body, '::1');
	});
}

test('DNS auto', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: 'auto'
	});

	t.true(isIPv4(response.body));
});

test('DNS IPv4', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: 'ipv4'
	});

	t.true(isIPv4(response.body));
});

if (IPv6supported) {
	test('DNS IPv6', withServer, async (t, server, got) => {
		server.get('/ok', echoIp);

		const response = await got('ok', {
			dnsLookupIpVersion: 'ipv6'
		});

		t.true(isIPv6(response.body));
	});
}

test('invalid dnsLookupIpVersion', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	await t.throwsAsync(got('ok', {
		dnsLookupIpVersion: 'test'
	} as any));
});

test.serial('deprecated `family` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await new Promise(resolve => {
		let request: CancelableRequest;
		(async () => {
			const warning = await pEvent(process, 'warning');
			t.is(warning.name, 'DeprecationWarning');
			request!.cancel();
			resolve();
		})();

		(async () => {
			request = got({
				family: '4'
			} as any);

			try {
				await request;
				t.fail();
			} catch {
				t.true(request!.isCanceled);
			}

			resolve();
		})();
	});
});

test('JSON request custom stringifier', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const payload = {a: 'b'};
	const customStringify = (object: any) => JSON.stringify({...object, c: 'd'});

	t.deepEqual((await got.post({
		stringifyJson: customStringify,
		json: payload
	})).body, customStringify(payload));
});
