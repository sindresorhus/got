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
import {once} from 'node:events';
import type {Handler} from 'express';
import getStream from 'get-stream';
import got, {
	HTTPError,
	RequestError,
} from '../source/index.js';
import test from './helpers/test.js';
import {errorMatching} from './helpers/error-matching.js';
import {rejects} from './helpers/rejects.js';
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

test('simple request', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	assert.strictEqual((await got('')).body, 'ok');
});

test('empty response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	assert.strictEqual((await got('')).body, '');
});

test('response has `requestUrl` property', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/empty', (_request, response) => {
		response.end();
	});

	assert.strictEqual((await got('')).requestUrl.href, `${server.url}/`);
	assert.strictEqual((await got('empty')).requestUrl.href, `${server.url}/empty`);
});

test('http errors have `response` property', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await rejects(got(''), HTTPError);
	assert.strictEqual(error?.response.statusCode, 404);
	assert.strictEqual(error?.response.body, 'not');
});

test('status code 304 doesn\'t throw', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 304;
		response.end();
	});

	const promise = got('');
	await assert.doesNotReject(promise);
	const {statusCode, body} = await promise;
	assert.strictEqual(statusCode, 304);
	assert.strictEqual(body, '');
});

test('doesn\'t throw if `options.throwHttpErrors` is false', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	assert.strictEqual((await got({throwHttpErrors: false})).body, 'not');
});

test('invalid protocol throws', async _t => {
	await assert.rejects(got('c:/nope.com').json(), errorMatching(RequestError, {message: 'Unsupported protocol: c:', code: 'ERR_UNSUPPORTED_PROTOCOL'}));
});

test('custom `options.encoding`', withServer, async (_t, server, got) => {
	const string = 'ok';

	server.get('/', (_request, response) => {
		response.end(string);
	});

	const data = (await got({encoding: 'base64'})).body;
	assert.strictEqual(data, Buffer.from(string).toString('base64'));
});

test('`options.encoding` doesn\'t affect streams', withServer, async (_t, server, got) => {
	const string = 'ok';

	server.get('/', (_request, response) => {
		response.end(string);
	});

	const data = await getStream(got.stream({encoding: 'base64'}));
	assert.strictEqual(data, string);
});

test('`got.stream(...).setEncoding(...)` works', withServer, async (_t, server, got) => {
	const string = 'ok';

	server.get('/', (_request, response) => {
		response.end(string);
	});

	const data = await getStream(got.stream('').setEncoding('base64'));
	assert.strictEqual(data, Buffer.from(string).toString('base64'));
});

test('`searchParams` option', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		assert.strictEqual(request.query.recent, 'true');
		response.end('recent');
	});

	assert.strictEqual((await got({searchParams: {recent: true}})).body, 'recent');
	assert.strictEqual((await got({searchParams: 'recent=true'})).body, 'recent');
});

test('response contains url', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	assert.strictEqual((await got('')).url, `${server.url}/`);
});

test('response contains got options', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	{
		const options = {
			username: 'foo',
			password: 'bar',
		};

		const {options: normalizedOptions} = (await got(options)).request;

		assert.strictEqual(normalizedOptions.username, options.username);
		assert.strictEqual(normalizedOptions.password, options.password);
	}

	{
		const options = {
			username: 'foo',
		};

		const {options: normalizedOptions} = (await got(options)).request;

		assert.strictEqual(normalizedOptions.username, options.username);
		assert.strictEqual(normalizedOptions.password, '');
	}

	{
		const options = {
			password: 'bar',
		};

		const {options: normalizedOptions} = (await got(options)).request;

		assert.strictEqual(normalizedOptions.username, '');
		assert.strictEqual(normalizedOptions.password, options.password);
	}
});

test('socket destroyed by the server throws ECONNRESET', withServer, async (_t, server, got) => {
	server.get('/', request => {
		request.socket.destroy();
	});
	await assert.rejects(got('', {retry: {limit: 0}}), {
		code: 'ECONNRESET',
	});
});

test('the response contains timings property', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {timings} = await got('');

	assert.ok(timings !== undefined);
	assert.strictEqual(timings.phases.total! >= 0, true);
});

test('throws an error if the server aborted the request', withServer, async (_t, server, got) => {
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

	const error = await rejects(got(''), {
		code: 'ECONNRESET',
	});

	assert.ok(error?.response.retryCount);
});

test('does not throw on close-delimited response without content-length', async _t => {
	const responseBody = '{"ok":true}';
	const {close, port} = await createRawHttpServer(socket => {
		socket.once('data', () => {
			socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${responseBody}`);
		});
	});

	try {
		const body = await got(`http://localhost:${port}`, {retry: {limit: 0}}).json();
		assert.deepStrictEqual(body, JSON.parse(responseBody));
	} finally {
		await close();
	}
});

test('statusMessage fallback', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(503);
		response.end();
	});

	const {statusMessage} = await got('', {
		throwHttpErrors: false,
		retry: {limit: 0},
	});

	assert.strictEqual(statusMessage, STATUS_CODES[503]);
});

test('does not destroy completed requests', withServer, async (_t, server, got) => {
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

	const endPromise = once(stream, 'end');

	const [socket] = await once(stream, 'socket') as unknown as [Socket];

	const closeListener = () => {
		assert.fail('Socket has been destroyed');
	};

	socket.once('close', closeListener);
	await new Promise(resolve => {
		setTimeout(resolve, 10);
	});

	socket.off('close', closeListener);
	await endPromise;

	options.agent.http.destroy();
});

testIPv6('IPv6 request', withServer, async (_t, server) => {
	server.get('/ok', echoIp);

	const response = await got(`http://[::1]:${server.port}/ok`);

	assert.strictEqual(response.body, '::1');
});

test('DNS auto', withServer, async (_t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: undefined,
	});

	const version = isIP(response.body);

	assert.strictEqual(version === 4 || version === 6, true);
});

test('DNS IPv4', withServer, async (_t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: 4,
	});

	assert.strictEqual(isIPv4(response.body), true);
});

// Travis CI Ubuntu Focal VM does not resolve IPv6 hostnames
testIPv6('DNS IPv6', withServer, async (_t, server, got) => {
	server.get('/ok', echoIp);

	const response = await got('ok', {
		dnsLookupIpVersion: 6,
	});

	assert.strictEqual(isIPv6(response.body), true);
});

test('invalid `dnsLookupIpVersion`', withServer, async (_t, server, got) => {
	server.get('/ok', echoIp);
	await assert.rejects(got('ok', {
		dnsLookupIpVersion: 'test',
	} as any));
});

test('deprecated `family` option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	await assert.rejects(got({
		// @ts-expect-error Legacy option
		family: 4,
	}), {
		message: 'Unexpected option: family',
	});
});

test('JSON request custom stringifier', withServer, async (_t, server, got) => {
	server.post('/', echoBody);

	const payload = {a: 'b'};
	const customStringify = (object: any) => JSON.stringify({...object, c: 'd'});

	assert.deepStrictEqual((await got.post({
		stringifyJson: customStringify,
		json: payload,
	})).body, customStringify(payload));
});

test('ClientRequest can throw before promise resolves', async _t => {
	const error = await rejects(got('http://example.com', {
		dnsLookup: ((_hostname: string, _options: unknown, callback: (error: undefined, hostname: string, family: number) => void) => {
			queueMicrotask(() => {
				// Node rejects the address before it connects. A valid but unreachable one would wait
				// for the operating system's connect timeout.
				callback(undefined, 'not-an-ip', 4);
			});
		}) as any,
	}));

	assert.strictEqual(error?.code, 'ERR_INVALID_IP_ADDRESS');
});

test('dnsLookup option accepts Node.js dns.lookup', withServer, async (_t, server, got) => {
	const dns = await import('node:dns');

	server.get('/', (_request, response) => {
		response.end('ok');
	});

	// This should work without type casting (regression test for #2426)
	const {body} = await got('', {
		dnsLookup: dns.lookup,
	});

	assert.strictEqual(body, 'ok');
});

test('status code 200 has response ok is true', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 200;
		response.end();
	});

	const promise = got('');
	await assert.doesNotReject(promise);
	const {statusCode, body, ok} = await promise;
	assert.strictEqual(ok, true);
	assert.strictEqual(statusCode, 200);
	assert.strictEqual(body, '');
});

test('status code 404 has response ok is false if error is not thrown', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const promise = got('', {throwHttpErrors: false});
	await assert.doesNotReject(promise);
	const {statusCode, body, ok} = await promise;
	assert.strictEqual(ok, false);
	assert.strictEqual(statusCode, 404);
	assert.strictEqual(body, '');
});

test('status code 404 has error response ok is false if error is thrown', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = (await rejects(got(''), HTTPError));
	assert.strictEqual(error.response.statusCode, 404);
	assert.strictEqual(error.response.ok, false);
	assert.strictEqual(error.response.body, 'not');
});

for (const statusCode of [200, 204]) {
	test(`HTTP/1.1 early hints remain separate from the final ${statusCode} response`, withServer, async (_t, server, got) => {
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

		assert.deepStrictEqual(informationalStatusCodes, [103, 103]);
		assert.deepStrictEqual(links, ['</first.css>; rel=preload', '</second.css>; rel=preload']);
		assert.strictEqual(finalResponses, 1);
		assert.strictEqual(response.statusCode, statusCode);
		assert.strictEqual(response.body, statusCode === 204 ? '' : 'final body');
		assert.strictEqual(response.headers['x-final'], 'yes');
		assert.strictEqual(response.headers.link, undefined);
	});
}

for (const compressed of [false, true]) {
	test(`HTTP/1.1 trailers remain separate after ${compressed ? 'gzip decoding' : 'plain body collection'}`, withServer, async (_t, server, got) => {
		// RFC 9112 section 7.1.2 and RFC 9110 section 6.5: trailers follow chunked content and remain a distinct field section.
		server.get('/', (_request, response) => {
			response.writeHead(200, {
				trailer: 'X-Checksum, X-Trailer-Only',
				'x-checksum': 'header value',
				...(compressed && {'content-encoding': 'gzip'}),
			});
			response.write(compressed ? gzipSync('complete body') : 'complete body');
			response.addTrailers({'X-Checksum': 'trailer value', 'X-Trailer-Only': 'late metadata'});
			response.end();
		});
		const response = await got('');

		assert.strictEqual(response.body, 'complete body');
		assert.strictEqual(response.headers['x-checksum'], 'header value');
		assert.strictEqual(response.headers['x-trailer-only'], undefined);
		assert.strictEqual(response.trailers['x-checksum'], 'trailer value');
		assert.strictEqual(response.trailers['x-trailer-only'], 'late metadata');
		assert.deepStrictEqual(response.rawTrailers, ['X-Checksum', 'trailer value', 'X-Trailer-Only', 'late metadata']);
	});
}

for (const statusCode of [200, 201]) {
	test(`Content-Location on ${statusCode} describes the representation without redirecting`, withServer, async (_t, server, got) => {
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

		assert.deepStrictEqual(response.body, {current: true});
		assert.strictEqual(response.statusCode, statusCode);
		assert.strictEqual(response.headers['content-location'], '/representation');
		assert.strictEqual(response.url, `${server.url}/`);
		assert.deepStrictEqual(response.redirectUrls, []);
		assert.strictEqual(metadataRequests, 0);
	});
}

test('single byte ranges use the transferred length rather than the complete representation length', withServer, async (_t, server, got) => {
	// RFC 9110 sections 14.4 and 15.3.7 distinguish Content-Range complete-length from Content-Length.
	const bytes = Buffer.from([0, 255, 13]);
	server.get('/', (request, response) => {
		assert.strictEqual(request.headers.range, 'bytes=2-4');
		response.writeHead(206, {'content-range': 'bytes 2-4/10', 'content-length': bytes.length});
		response.end(bytes);
	});
	const response = await got('', {headers: {range: 'bytes=2-4'}, responseType: 'buffer', strictContentLength: true});

	assert.strictEqual(response.statusCode, 206);
	assert.strictEqual(response.ok, true);
	assert.deepStrictEqual([...response.body], [...bytes]);
	assert.strictEqual(response.headers['content-range'], 'bytes 2-4/10');
});

test('multipart byte ranges preserve part boundaries and per-part metadata', withServer, async (_t, server, got) => {
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
		assert.strictEqual(request.headers.range, 'bytes=0-1,8-9');
		response.writeHead(206, {'content-type': 'multipart/byteranges; boundary=range-boundary', 'content-length': Buffer.byteLength(body)});
		response.end(body);
	});
	const response = await got('', {headers: {range: 'bytes=0-1,8-9'}, strictContentLength: true});

	assert.strictEqual(response.statusCode, 206);
	assert.strictEqual(response.body, body);
	assert.strictEqual(response.headers['content-range'], undefined);
	assert.strictEqual(response.headers['content-type'], 'multipart/byteranges; boundary=range-boundary');
});

test('unsatisfied byte ranges retain complete-length metadata on HTTPError', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		assert.strictEqual(request.headers.range, 'bytes=999-');
		response.writeHead(416, {'content-range': 'bytes */10'});
		response.end('range unavailable');
	});
	const error = await rejects(got('', {headers: {range: 'bytes=999-'}, retry: {limit: 0}}), HTTPError);

	assert.strictEqual(error.response.statusCode, 416);
	assert.strictEqual(error.response.headers['content-range'], 'bytes */10');
	assert.strictEqual(error.response.body, 'range unavailable');
});

test('a changed If-Range validator allows the full 200 representation', withServer, async (_t, server, got) => {
	// RFC 9110 section 13.1.5: a failed If-Range condition ignores Range instead of returning a partial response.
	server.get('/', (request, response) => {
		assert.strictEqual(request.headers.range, 'bytes=0-1');
		assert.strictEqual(request.headers['if-range'], '"old"');
		response.writeHead(200, {etag: '"current"'});
		response.end('complete representation');
	});
	const response = await got('', {headers: {range: 'bytes=0-1', 'if-range': '"old"'}});

	assert.strictEqual(response.statusCode, 200);
	assert.strictEqual(response.body, 'complete representation');
	assert.strictEqual(response.headers.etag, '"current"');
	assert.strictEqual(response.headers['content-range'], undefined);
});
