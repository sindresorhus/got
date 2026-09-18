import assert from 'node:assert/strict';
import process from 'node:process';
import {Buffer} from 'node:buffer';
import {STATUS_CODES, Agent} from 'node:http';
import os from 'node:os';
import {gzipSync} from 'node:zlib';
import {
	isIPv4,
	isIPv6,
	isIP,
	type Socket,
} from 'node:net';
import test from 'ava';
import type {Handler} from 'express';
import getStream from 'get-stream';
import {pEvent} from 'p-event';
import got, {
	HTTPError,
	RequestError,
	type ReadError,
} from '../source/index.js';
import {createRawHttpServer} from './helpers/server-tools.js';
import withServer from './helpers/with-server.js';

// eslint-disable-next-line @typescript-eslint/naming-convention
const IPv6supported = Object.values(os.networkInterfaces()).some(iface => iface?.some(addr => !addr.internal && addr.family === 'IPv6'));

// eslint-disable-next-line @typescript-eslint/naming-convention
const testIPv6 = (IPv6supported && process.env.TRAVIS_DIST !== 'bionic' && process.env.TRAVIS_DIST !== 'focal') ? test : test.skip;

const echoIp: Handler = (request, response) => {
	const address = request.socket.remoteAddress;
	if (address === undefined) {
		response.end();
		return;
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

	t.is((await got('')).requestUrl.toString(), `${server.url}/`);
	t.is((await got('empty')).requestUrl.toString(), `${server.url}/empty`);
});

test('http errors have `response` property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync<HTTPError>(got(''), {instanceOf: HTTPError});
	t.is(error?.response.statusCode, 404);
	t.is(error?.response.body, 'not');
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
		instanceOf: RequestError,
		message: 'Unsupported protocol: c:',
		code: 'ERR_UNSUPPORTED_PROTOCOL',
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
			password: 'bar',
		};

		const {options: normalizedOptions} = (await got(options)).request;

		t.is(normalizedOptions.username, options.username);
		t.is(normalizedOptions.password, options.password);
	}

	{
		const options = {
			username: 'foo',
		};

		const {options: normalizedOptions} = (await got(options)).request;

		t.is(normalizedOptions.username, options.username);
		t.is(normalizedOptions.password, '');
	}

	{
		const options = {
			password: 'bar',
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

	await t.throwsAsync(got('', {retry: {limit: 0}}), {
		code: 'ECONNRESET',
	});
});

test('the response contains timings property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {timings} = await got('');

	assert.ok(timings !== undefined);
	t.true(timings.phases.total! >= 0);
});

test('throws an error if the server aborted the request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-type': 'text/plain',
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
		code: 'ECONNRESET',
	});

	t.truthy(error?.response.retryCount);
});

test('does not throw on close-delimited response without content-length', async t => {
	const responseBody = '{"ok":true}';
	const {close, port} = await createRawHttpServer(socket => {
		socket.once('data', () => {
			socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${responseBody}`);
		});
	});

	try {
		const body = await got(`http://localhost:${port}`, {retry: {limit: 0}}).json();
		t.deepEqual(body, JSON.parse(responseBody));
	} finally {
		await close();
	}
});

test('statusMessage fallback', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(503);
		response.end();
	});

	const {statusMessage} = await got('', {
		throwHttpErrors: false,
		retry: {limit: 0},
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
			http: new Agent({keepAlive: true}),
		},
		retry: {
			limit: 0,
		},
	};

	const stream = got.stream(options);
	stream.resume();

	const endPromise = pEvent(stream, 'end');

	const socket = await pEvent(stream, 'socket') as Socket;

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

testIPv6('IPv6 request', withServer, async (t, server) => {
	server.get('/ok', echoIp);

	const response = await got(`http://[::1]:${server.port}/ok`);

	t.is(response.body, '::1');
});

test('DNS auto', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: undefined,
	});

	const version = isIP(response.body);

	t.true(version === 4 || version === 6);
});

test('DNS IPv4', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: 4,
	});

	t.true(isIPv4(response.body));
});

// Travis CI Ubuntu Focal VM does not resolve IPv6 hostnames
testIPv6('DNS IPv6', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: 6,
	});

	t.true(isIPv6(response.body));
});

test('invalid `dnsLookupIpVersion`', withServer, async (t, server, got) => {
	server.get('/ok', echoIp);

	await t.throwsAsync(got('ok', {
		dnsLookupIpVersion: 'test',
	} as any));
});

test('deprecated `family` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await t.throwsAsync(got({
		// @ts-expect-error Legacy option
		family: 4,
	}), {
		message: 'Unexpected option: family',
	});
});

test('JSON request custom stringifier', withServer, async (t, server, got) => {
	server.post('/', echoBody);

	const payload = {a: 'b'};
	const customStringify = (object: any) => JSON.stringify({...object, c: 'd'});

	t.deepEqual((await got.post({
		stringifyJson: customStringify,
		json: payload,
	})).body, customStringify(payload));
});

test('ClientRequest can throw before promise resolves', async t => {
	const error = await t.throwsAsync<RequestError>(got('http://example.com', {
		dnsLookup: ((_hostname: string, _options: unknown, callback: (error: undefined, hostname: string, family: number) => void) => {
			queueMicrotask(() => {
				callback(undefined, 'fe80::0000:0000:0000:0000', 6);
			});
		}) as any,
	}));

	// Node.js 20+ returns ERR_INVALID_IP_ADDRESS, older versions return EINVAL, EHOSTUNREACH, or ETIMEDOUT
	t.true(['EINVAL', 'EHOSTUNREACH', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS'].includes(error.code));
});

test('dnsLookup option accepts Node.js dns.lookup', withServer, async (t, server, got) => {
	const dns = await import('node:dns');

	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// This should work without type casting (regression test for #2426)
	const {body} = await got('', {
		dnsLookup: dns.lookup,
	});

	t.is(body, 'ok');
});

test('status code 200 has response ok is true', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end();
	});

	const promise = got('');
	await t.notThrowsAsync(promise);
	const {statusCode, body, ok} = await promise;
	t.true(ok);
	t.is(statusCode, 200);
	t.is(body, '');
});

test('status code 404 has response ok is false if error is not thrown', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const promise = got('', {throwHttpErrors: false});
	await t.notThrowsAsync(promise);
	const {statusCode, body, ok} = await promise;
	t.false(ok);
	t.is(statusCode, 404);
	t.is(body, '');
});

test('status code 404 has error response ok is false if error is thrown', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = (await t.throwsAsync<HTTPError>(got(''), {instanceOf: HTTPError}));
	t.is(error.response.statusCode, 404);
	t.false(error.response.ok);
	t.is(error.response.body, 'not');
});

for (const statusCode of [200, 204]) {
	test(`HTTP/1.1 early hints remain separate from the final ${statusCode} response`, withServer, async (t, server, got) => {
		// RFC 8297 section 2: multiple 103 responses do not replace the final response or its fields.
		server.get('/', (_request, response) => {
			response.writeEarlyHints({link: '</first.css>; rel=preload'});
			response.writeEarlyHints({link: '</second.css>; rel=preload'});
			response.writeHead(statusCode, {'x-final': 'yes'});
			response.end(statusCode === 204 ? undefined : 'final body');
		});
		const informationalStatusCodes: number[] = [];
		const links: Array<string | string[] | undefined> = [];
		let finalResponses = 0;
		const response = await got('').on('request', request => {
			request.on('information', information => {
				informationalStatusCodes.push(information.statusCode);
				links.push(information.headers.link);
			});
		}).on('response', () => {
			finalResponses++;
		});

		t.deepEqual(informationalStatusCodes, [103, 103]);
		t.deepEqual(links, ['</first.css>; rel=preload', '</second.css>; rel=preload']);
		t.is(finalResponses, 1);
		t.is(response.statusCode, statusCode);
		t.is(response.body, statusCode === 204 ? '' : 'final body');
		t.is(response.headers['x-final'], 'yes');
		t.is(response.headers.link, undefined);
	});
}

for (const compressed of [false, true]) {
	test(`HTTP/1.1 trailers remain separate after ${compressed ? 'gzip decoding' : 'plain body collection'}`, withServer, async (t, server, got) => {
		// RFC 9112 section 7.1.2 and RFC 9110 section 6.5: trailers follow chunked content and remain a distinct field section.
		server.get('/', (_request, response) => {
			response.writeHead(200, {
				trailer: 'X-Checksum, X-Trailer-Only',
				'x-checksum': 'header value',
				...(compressed ? {'content-encoding': 'gzip'} : {}),
			});
			response.write(compressed ? gzipSync('complete body') : 'complete body');
			response.addTrailers({'X-Checksum': 'trailer value', 'X-Trailer-Only': 'late metadata'});
			response.end();
		});
		const response = await got('');

		t.is(response.body, 'complete body');
		t.is(response.headers['x-checksum'], 'header value');
		t.is(response.headers['x-trailer-only'], undefined);
		t.is(response.trailers['x-checksum'], 'trailer value');
		t.is(response.trailers['x-trailer-only'], 'late metadata');
		t.deepEqual(response.rawTrailers, ['X-Checksum', 'trailer value', 'X-Trailer-Only', 'late metadata']);
	});
}

for (const statusCode of [200, 201]) {
	test(`Content-Location on ${statusCode} describes the representation without redirecting`, withServer, async (t, server, got) => {
		// RFC 9110 section 8.7: Content-Location is representation metadata, not a replacement request target.
		let metadataRequests = 0;
		server.get('/', (_request, response) => {
			response.writeHead(statusCode, {'content-location': '/representation', 'content-type': 'application/json'});
			response.end('{"current":true}');
		});
		server.get('/representation', (_request, response) => {
			metadataRequests++;
			response.end('not a redirect');
		});
		const response = await got<{current: boolean}>('', {responseType: 'json'});

		t.deepEqual(response.body, {current: true});
		t.is(response.statusCode, statusCode);
		t.is(response.headers['content-location'], '/representation');
		t.is(response.url, `${server.url}/`);
		t.deepEqual(response.redirectUrls, []);
		t.is(metadataRequests, 0);
	});
}

test('single byte ranges use the transferred length rather than the complete representation length', withServer, async (t, server, got) => {
	// RFC 9110 sections 14.4 and 15.3.7 distinguish Content-Range complete-length from Content-Length.
	const bytes = Buffer.from([0, 255, 13]);
	server.get('/', (request, response) => {
		t.is(request.headers.range, 'bytes=2-4');
		response.writeHead(206, {'content-range': 'bytes 2-4/10', 'content-length': bytes.length});
		response.end(bytes);
	});
	const response = await got('', {headers: {range: 'bytes=2-4'}, responseType: 'buffer', strictContentLength: true});

	t.is(response.statusCode, 206);
	t.true(response.ok);
	t.deepEqual([...response.body], [...bytes]);
	t.is(response.headers['content-range'], 'bytes 2-4/10');
});

test('multipart byte ranges preserve part boundaries and per-part metadata', withServer, async (t, server, got) => {
	// RFC 9110 section 15.3.7.2: each part carries Content-Range; the overall response does not.
	const body = [
		'--range-boundary',
		'Content-Type: text/plain',
		'Content-Range: bytes 0-1/10',
		'',
		'ab',
		'--range-boundary',
		'Content-Type: text/plain',
		'Content-Range: bytes 8-9/10',
		'',
		'ij',
		'--range-boundary--',
		'',
	].join('\r\n');
	server.get('/', (request, response) => {
		t.is(request.headers.range, 'bytes=0-1,8-9');
		response.writeHead(206, {'content-type': 'multipart/byteranges; boundary=range-boundary', 'content-length': Buffer.byteLength(body)});
		response.end(body);
	});
	const response = await got('', {headers: {range: 'bytes=0-1,8-9'}, strictContentLength: true});

	t.is(response.statusCode, 206);
	t.is(response.body, body);
	t.is(response.headers['content-range'], undefined);
	t.is(response.headers['content-type'], 'multipart/byteranges; boundary=range-boundary');
});

test('unsatisfied byte ranges retain complete-length metadata on HTTPError', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		t.is(request.headers.range, 'bytes=999-');
		response.writeHead(416, {'content-range': 'bytes */10'});
		response.end('range unavailable');
	});
	const error = await t.throwsAsync<HTTPError>(got('', {headers: {range: 'bytes=999-'}, retry: {limit: 0}}), {instanceOf: HTTPError});

	t.is(error.response.statusCode, 416);
	t.is(error.response.headers['content-range'], 'bytes */10');
	t.is(error.response.body, 'range unavailable');
});

test('a changed If-Range validator allows the full 200 representation', withServer, async (t, server, got) => {
	// RFC 9110 section 13.1.5: a failed If-Range condition ignores Range instead of returning a partial response.
	server.get('/', (request, response) => {
		t.is(request.headers.range, 'bytes=0-1');
		t.is(request.headers['if-range'], '"old"');
		response.writeHead(200, {etag: '"current"'});
		response.end('complete representation');
	});
	const response = await got('', {headers: {range: 'bytes=0-1', 'if-range': '"old"'}});

	t.is(response.statusCode, 200);
	t.is(response.body, 'complete representation');
	t.is(response.headers.etag, '"current"');
	t.is(response.headers['content-range'], undefined);
});
