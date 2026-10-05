import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {gzip} from 'node:zlib';
import assert from 'node:assert/strict';
import type {Handler} from 'express';
import Responselike from 'responselike';
import getStream from 'get-stream';
import got, {
	type Options,
	HTTPError,
	MaxRedirectsError,
	ParseError,
	RequestError,
	TimeoutError,
} from '../source/index.js';
import {rejects} from './helpers/rejects.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';
import withServer, {withHttpsServer} from './helpers/with-server.js';

const gzipAsync = promisify(gzip);

async function getFormDataContentLength(form: FormData): Promise<string> {
	return String((await new Response(form).arrayBuffer()).byteLength);
}

const reachedHandler: Handler = (_request, response) => {
	const body = 'reached';

	response.writeHead(200, {
		'content-length': body.length,
	});
	response.end(body);
};

const finiteHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/',
	});
	response.end();
};

const relativeHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: '/',
	});
	response.end();
};

const unixProtocol: Handler = (_request, response) => {
	response.writeHead(302, {
		location: 'unix:/var/run/docker.sock:/containers/json',
	});
	response.end();
};

const unixHostname: Handler = (_request, response) => {
	response.writeHead(302, {
		location: 'http://unix:/var/run/docker.sock:/containers/json',
	});
	response.end();
};

const unixProtocolWithoutSocketPath: Handler = (_request, response) => {
	response.writeHead(302, {
		location: 'unix:/',
	});
	response.end();
};

test('cannot redirect to UNIX protocol when UNIX sockets are enabled', withServer, async (_t, server, got) => {
	server.get('/protocol', unixProtocol);
	server.get('/hostname', unixHostname);
	server.get('/protocol-without-socket-path', unixProtocolWithoutSocketPath);

	const gotUnixSocketsEnabled = got.extend({enableUnixSockets: true});

	assert.strictEqual(gotUnixSocketsEnabled.defaults.options.enableUnixSockets, true);
	await assert.rejects(gotUnixSocketsEnabled('protocol'), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
	await assert.rejects(gotUnixSocketsEnabled('hostname'), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
	await assert.rejects(gotUnixSocketsEnabled('protocol-without-socket-path'), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
});

test('cannot redirect to UNIX protocol when UNIX sockets are not enabled', withServer, async (_t, server, got) => {
	server.get('/protocol', unixProtocol);
	server.get('/hostname', unixHostname);
	server.get('/protocol-without-socket-path', unixProtocolWithoutSocketPath);

	const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

	assert.strictEqual(gotUnixSocketsDisabled.defaults.options.enableUnixSockets, false);
	await assert.rejects(gotUnixSocketsDisabled('protocol'), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
	await assert.rejects(gotUnixSocketsDisabled('hostname'), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
	await assert.rejects(gotUnixSocketsDisabled('protocol-without-socket-path'), errorMatching(RequestError, {message: 'Cannot redirect to UNIX socket'}));
});

test('follows redirect to ordinary http://unix host', withServer, async (_t, server, got) => {
	server.get('/hostname-without-socket-path', (_request, response) => {
		response.writeHead(302, {
			location: `http://unix:${server.port}/foo`,
		});
		response.end();
	});
	server.get('/foo', reachedHandler);

	const dnsLookup = ((_: string, options: {all?: boolean}, callback: (error: undefined, address: string | Array<{address: string; family: number}>, family?: number) => void) => {
		if (options.all) {
			callback(undefined, [{address: '127.0.0.1', family: 4}]);
			return;
		}

		callback(undefined, '127.0.0.1', 4);
	}) as any;

	const {body, redirectUrls} = await got('hostname-without-socket-path', {
		dnsLookup,
	});

	assert.strictEqual(body, 'reached');
	assert.deepStrictEqual(redirectUrls.map(String), [`http://unix:${server.port}/foo`]);
});

test('follows redirect', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite');
	assert.strictEqual(body, 'reached');
	assert.deepStrictEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('`allowAbsoluteUrls: false` allows redirects with `prefixUrl`', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite', {allowAbsoluteUrls: false});
	assert.strictEqual(body, 'reached');
	assert.deepStrictEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('`allowAbsoluteUrls: false` allows redirects outside the `prefixUrl` path', withServer, async (_t, server, got) => {
	server.get('/api/finite', (_request, response) => {
		response.writeHead(302, {
			location: '/login',
		});
		response.end();
	});

	server.get('/login', reachedHandler);

	const {body, redirectUrls} = await got('finite', {
		allowAbsoluteUrls: false,
		prefixUrl: `${server.url}/api`,
	});

	assert.strictEqual(body, 'reached');
	assert.deepStrictEqual(redirectUrls.map(String), [`${server.url}/login`]);
});

test('`allowAbsoluteUrls: false` rejects absolute URL set in beforeRedirect hook', withServer, async (_t, server, got) => {
	server.get('/finite', finiteHandler);
	await assert.rejects(got('finite', {
		allowAbsoluteUrls: false,
		hooks: {
			beforeRedirect: [
				options => {
					options.url = new URL(`${server.url}/changed`);
				},
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'}));
});

test('`allowAbsoluteUrls: false` rejects in-place URL mutation in beforeRedirect hook outside prefixUrl origin', withServer, async (_t, server, got) => {
	server.get('/api/finite', (_request, response) => {
		response.writeHead(302, {
			location: '/api/next',
		});
		response.end();
	});
	await assert.rejects(got('finite', {
		allowAbsoluteUrls: false,
		prefixUrl: `${server.url}/api`,
		hooks: {
			beforeRedirect: [
				options => {
					options.url!.hostname = 'example.com';
				},
			],
		},
	}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
});

test('`allowAbsoluteUrls: false` rejects prefixUrl mutation in beforeRedirect hook around absolute URL', withServer, async (t, server, got) => {
	await withServer(t, async (_t, redirectServer) => {
		redirectServer.get('/finite', (_request, response) => {
			response.writeHead(302, {
				location: '/next',
			});
			response.end();
		});
		await assert.rejects(got(`${redirectServer.url}/finite`, {
			allowAbsoluteUrls: false,
			prefixUrl: '',
			hooks: {
				beforeRedirect: [
					options => {
						options.prefixUrl = server.url;
					},
				],
			},
		}), errorMatching(RequestError, {message: 'The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false'}));
	});
});

test('does not follow redirect when followRedirect is a function and returns false', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, statusCode} = await got('finite', {followRedirect: () => false});
	assert.notStrictEqual(body, 'reached');
	assert.strictEqual(statusCode, 302);
});

test('follows redirect when followRedirect is a function and returns true', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite', {followRedirect: () => true});
	assert.strictEqual(body, 'reached');
	assert.deepStrictEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('followRedirect gets plainResponse and does not follow', withServer, async (_t, server, got) => {
	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/redirect',
		});
		response.end();
	});

	const {statusCode} = await got('temporary', {
		followRedirect(response) {
			assert.strictEqual(response.headers.location, '/redirect');
			return false;
		},
	});
	assert.strictEqual(statusCode, 307);
});

test('follows 307, 308 redirect', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/',
		});
		response.end();
	});

	server.get('/permanent', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});

	const temporaryBody = (await got('temporary')).body;
	assert.strictEqual(temporaryBody, 'reached');

	const permBody = (await got('permanent')).body;
	assert.strictEqual(permBody, 'reached');
});

test('does not follow redirect when disabled', withServer, async (_t, server, got) => {
	server.get('/', finiteHandler);

	assert.strictEqual((await got({followRedirect: false})).statusCode, 302);
});

test('ignores invalid compressed redirect bodies when following redirects', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/target',
			'content-encoding': 'gzip',
		});
		response.end('not-a-valid-gzip-stream');
	});

	server.get('/target', (_request, response) => {
		response.end('target-ok');
	});

	const response = await got('redirect', {
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(response.body, 'target-ok');
});

test('followRedirect runs before redirect body decompression', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/target',
			'content-encoding': 'gzip',
		});
		response.end('not-a-valid-gzip-stream');
	});

	server.get('/target', (_request, response) => {
		response.end('target-ok');
	});

	let sawRedirectResponse = false;

	const response = await got('redirect', {
		retry: {
			limit: 0,
		},
		followRedirect(response) {
			if (response.statusCode === 302) {
				sawRedirectResponse = true;
				assert.strictEqual(response.headers.location, '/target');
				assert.strictEqual(response.requestUrl.href, `${server.url}/redirect`);
			} else {
				// The first response is the one carrying the redirect.
			}

			return true;
		},
	});

	assert.strictEqual(sawRedirectResponse, true);
	assert.strictEqual(response.body, 'target-ok');
});

test('decompresses compressed redirect bodies when redirects are not followed', withServer, async (_t, server, got) => {
	const compressedBody = await gzipAsync('redirect-body');

	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/target',
			'content-encoding': 'gzip',
		});
		response.end(compressedBody);
	});

	const response = await got('redirect', {
		followRedirect: false,
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(response.statusCode, 302);
	assert.strictEqual(response.body, 'redirect-body');
});

test('relative redirect works', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	assert.strictEqual((await got('relative')).body, 'reached');
});

test('throws on endless redirects - default behavior', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url,
		});
		response.end();
	});

	const error = await rejects(got(''), {message: 'Redirected 10 times. Aborting.'});

	assert.deepStrictEqual(error?.response.redirectUrls.map(String), Array.from({length: 10}, () => `${server.url}/`));
	assert.strictEqual(error?.code, 'ERR_TOO_MANY_REDIRECTS');
});

test('custom `maxRedirects` option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url,
		});
		response.end();
	});

	const error = await rejects(got('', {maxRedirects: 5}), {message: 'Redirected 5 times. Aborting.'});

	assert.deepStrictEqual(error?.response.redirectUrls.map(String), Array.from({length: 5}, () => `${server.url}/`));
	assert.strictEqual(error?.code, 'ERR_TOO_MANY_REDIRECTS');
});

test('searchParams are not breaking redirects', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/relativeSearchParam', (request, response) => {
		assert.strictEqual(request.query.bang, '1');

		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	assert.strictEqual((await got('relativeSearchParam', {searchParams: 'bang=1'})).body, 'reached');
});

test('redirects GET and HEAD requests', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});
	await assert.rejects(got.get(''), errorMatching(MaxRedirectsError, {code: 'ERR_TOO_MANY_REDIRECTS'}));
});

test('redirects POST requests', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});
	await assert.rejects(got.post({body: 'wow'}), errorMatching(MaxRedirectsError, {code: 'ERR_TOO_MANY_REDIRECTS'}));
});

test('redirects on 303 if GET or HEAD', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);

	server.head('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {url, headers, request} = await got.head('seeOther');
	assert.strictEqual(url, `${server.url}/`);
	assert.strictEqual(headers['content-length'], 'reached'.length.toString());
	assert.strictEqual(request.options.method, 'HEAD');
});

test('removes body on GET redirect', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		request.pipe(response);
	});

	server.post('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {headers, body} = await got.post('seeOther', {body: 'hello'});
	assert.strictEqual(body, '');
	assert.strictEqual(headers['content-length'], '0');
});

test('does not reuse dropped streamed body state on later bodyless 307 redirect', withServer, async (_t, server, got) => {
	server.post('/seeOther', (request, response) => {
		request.once('data', () => {
			response.writeHead(303, {
				location: '/temporary',
			});
			response.end();
		});
	});

	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/target',
		});
		response.end();
	});

	server.get('/target', (request, response) => {
		response.end(request.method);
	});

	const {body} = await got.post('seeOther', {
		body: Readable.from(['dropped-body']),
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, 'GET');
});

test('removes request body headers on GET redirect', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.end(JSON.stringify({
			method: request.method,
			headers: request.headers,
		}));
	});

	server.post('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {method, headers} = await got.post('seeOther', {
		body: 'hello',
		headers: {
			'content-type': 'text/plain',
			'content-language': 'en',
			'content-location': '/body',
			'content-encoding': 'gzip',
		},
	}).json<{method: string; headers: Record<string, string | undefined>}>();

	assert.strictEqual(method, 'GET');
	assert.strictEqual(headers['content-length'], undefined);
	assert.strictEqual(headers['content-type'], undefined);
	assert.strictEqual(headers['content-language'], undefined);
	assert.strictEqual(headers['content-location'], undefined);
	assert.strictEqual(headers['content-encoding'], undefined);
});

for (const statusCode of [301, 302, 303]) {
	test(`removes stale integrity metadata when ${statusCode} rewrites POST to GET`, withServer, async (_t, server, got) => {
		const payload = 'uploaded representation';
		const checksum = createHash('sha256').update(payload).digest('base64');
		const bodyHeaders = {
			digest: `sha-256=${checksum}`,
			'content-digest': `sha-256=:${checksum}:`,
			'repr-digest': `sha-256=:${checksum}:`,
			'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
		};
		server.post('/redirect', async (request, response) => {
			assert.strictEqual(Buffer.concat(await request.toArray()).toString(), payload);
			for (const [name, value] of Object.entries(bodyHeaders)) {
				assert.strictEqual(request.headers[name], value);
			}

			response.writeHead(statusCode, {location: '/destination'});
			response.end();
		});
		server.get('/destination', async (request, response) => {
			response.json({headers: request.headers, body: Buffer.concat(await request.toArray()).toString()});
		});

		const {headers, body} = await got.post('redirect', {
			body: payload,
			headers: {
				...bodyHeaders,
				'want-content-digest': 'sha-256=10',
				'want-repr-digest': 'sha-256=10',
			},
			methodRewriting: statusCode !== 303,
			retry: {limit: 0},
		}).json<{headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(body, '');
		for (const name of Object.keys(bodyHeaders)) {
			assert.strictEqual(headers[name], undefined);
		}

		assert.strictEqual(headers['want-content-digest'], 'sha-256=10');
		assert.strictEqual(headers['want-repr-digest'], 'sha-256=10');
	});
}

for (const statusCode of [307, 308]) {
	test(`preserves integrity metadata when ${statusCode} retains the request body`, withServer, async (_t, server, got) => {
		const payload = 'uploaded representation';
		const checksum = createHash('sha256').update(payload).digest('base64');
		const bodyHeaders = {
			digest: `sha-256=${checksum}`,
			'content-digest': `sha-256=:${checksum}:`,
			'repr-digest': `sha-256=:${checksum}:`,
			'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
		};
		server.post('/redirect', async (request, response) => {
			assert.strictEqual(Buffer.concat(await request.toArray()).toString(), payload);
			response.writeHead(statusCode, {location: '/destination'});
			response.end();
		});
		server.post('/destination', async (request, response) => {
			response.json({headers: request.headers, body: Buffer.concat(await request.toArray()).toString()});
		});

		const {headers, body} = await got.post('redirect', {
			body: payload,
			headers: bodyHeaders,
			retry: {limit: 0},
		}).json<{headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(body, payload);
		for (const [name, value] of Object.entries(bodyHeaders)) {
			assert.strictEqual(headers[name], value);
		}
	});
}

test('redirect hooks can provide fresh body integrity metadata after a method rewrite', withServer, async (_t, server, got) => {
	const originalBody = 'original representation';
	const replacementBody = 'replacement representation';
	const originalChecksum = createHash('sha256').update(originalBody).digest('base64');
	const replacementChecksum = createHash('sha256').update(replacementBody).digest('base64');
	const replacementHeaders = {
		digest: `sha-256=${replacementChecksum}`,
		'content-digest': `sha-256=:${replacementChecksum}:`,
		'repr-digest': `sha-256=:${replacementChecksum}:`,
		'last-modified': 'Thu, 02 Jan 2025 00:00:00 GMT',
	};
	server.post('/redirect', async (request, response) => {
		assert.strictEqual(Buffer.concat(await request.toArray()).toString(), originalBody);
		response.writeHead(303, {location: '/destination'});
		response.end();
	});
	server.put('/destination', async (request, response) => {
		response.json({headers: request.headers, body: Buffer.concat(await request.toArray()).toString()});
	});

	const {headers, body} = await got.post('redirect', {
		body: originalBody,
		headers: {
			digest: `sha-256=${originalChecksum}`,
			'content-digest': `sha-256=:${originalChecksum}:`,
			'repr-digest': `sha-256=:${originalChecksum}:`,
			'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
		},
		hooks: {
			beforeRedirect: [options => {
				assert.strictEqual(options.method, 'GET');
				for (const name of Object.keys(replacementHeaders)) {
					assert.strictEqual(options.headers[name], undefined);
				}

				options.method = 'PUT';
				options.body = replacementBody;
				Object.assign(options.headers, replacementHeaders);
			}],
		},
		retry: {limit: 0},
	}).json<{headers: Record<string, string | undefined>; body: string}>();

	assert.strictEqual(body, replacementBody);
	for (const [name, value] of Object.entries(replacementHeaders)) {
		assert.strictEqual(headers[name], value);
	}
});

test('redirects on 303 response even on post, put, delete', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);

	server.post('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {url, body} = await got.post('seeOther', {body: 'wow'});
	assert.strictEqual(url, `${server.url}/`);
	assert.strictEqual(body, 'reached');
});

test('redirects from http to https work', withServer, async (t, serverHttp) => {
	await withHttpsServer()(t, async (_t, serverHttps, got) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttp.get('/httpToHttps', (_request, response) => {
			response.writeHead(302, {
				location: serverHttps.url,
			});
			response.end();
		});

		assert.strictEqual((await got('httpToHttps', {
			prefixUrl: serverHttp.url,
		})).body, 'https');
	});
});

test('redirects from https to http work', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer(t, async (_t, serverHttp) => {
		serverHttp.get('/', (_request, response) => {
			response.end('http');
		});

		serverHttps.get('/', (_request, response) => {
			response.end('https');
		});

		serverHttps.get('/httpsToHttp', (_request, response) => {
			response.writeHead(302, {
				location: serverHttp.url,
			});
			response.end();
		});

		assert.strictEqual((await got('httpsToHttp', {
			prefixUrl: serverHttps.url,
		})).body, 'http');
	});
});

test('redirects works with lowercase method', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	const {body} = await got('relative', {method: 'head'});
	assert.strictEqual(body, '');
});

test('redirect response contains new url', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {url} = await got('finite');
	assert.strictEqual(url, `${server.url}/`);
});

test('redirect response contains old url', withServer, async (_t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {requestUrl} = await got('finite');
	assert.strictEqual(requestUrl.toString(), `${server.url}/finite`);
});

test('redirect response contains UTF-8 with binary encoding', withServer, async (_t, server, got) => {
	server.get('/utf8-url-%C3%A1%C3%A9', reachedHandler);

	server.get('/redirect-with-utf8-binary', (_request, response) => {
		response.writeHead(302, {
			location: Buffer.from((new URL('/utf8-url-áé', server.url)).href, 'utf8').toString('binary'),
		});
		response.end();
	});

	assert.strictEqual((await got('redirect-with-utf8-binary')).body, 'reached');
});

test('redirect response contains UTF-8 with URI encoding', withServer, async (_t, server, got) => {
	server.get('/', (request, response) => {
		assert.strictEqual(request.query.test, 'it’s ok');
		response.end('reached');
	});

	server.get('/redirect-with-uri-encoded-location', (_request, response) => {
		response.writeHead(302, {
			location: new URL('/?test=it’s+ok', server.url).href,
		});
		response.end();
	});

	assert.strictEqual((await got('redirect-with-uri-encoded-location')).body, 'reached');
});

test('throws on invalid redirect URL', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'http://',
		});
		response.end();
	});
	await assert.rejects(got(''), {
		code: 'ERR_INVALID_URL',
	});
});

test('redirect uses port from redirect URL, not from original request', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (_request, response) => {
			response.end('ok');
		});

		const {body} = await got('');
		assert.strictEqual(body, 'ok');
	});
});

test('body is reset on GET redirect', withServer, async (_t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	server.get('/', (_request, response) => {
		response.end();
	});

	let calls = 0;
	await got.post('', {
		body: 'foobar',
		hooks: {
			beforeRedirect: [
				options => {
					calls++;
					assert.strictEqual(options.body, undefined);
				},
			],
		},
	});
	assert.strictEqual(calls, 1);

	await got.post('', {
		json: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					calls++;
					assert.strictEqual(options.body, undefined);
				},
			],
		},
	});
	assert.strictEqual(calls, 2);

	await got.post('', {
		form: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					calls++;
					assert.strictEqual(options.body, undefined);
				},
			],
		},
	});
	assert.strictEqual(calls, 3);
});

test('body is passed on POST redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const {body} = await got.post('redirect', {
		body: 'foobar',
		hooks: {
			beforeRedirect: [
				options => {
					assert.strictEqual(options.body, 'foobar');
				},
			],
		},
	});

	assert.strictEqual(body, 'foobar');
});

test('does not forward body on cross-origin POST redirect by default', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const redirectedRequest = await got.post('redirect', {
			body: 'foobar',
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'GET');
						assert.strictEqual(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'GET');
		assert.strictEqual(redirectedRequest.body, '');
		assert.strictEqual(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not forward body on cross-origin permanent POST redirect by default', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', (_request, response) => {
			response.writeHead(301, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const redirectedRequest = await got.post('redirect', {
			body: 'foobar',
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'GET');
						assert.strictEqual(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'GET');
		assert.strictEqual(redirectedRequest.body, '');
		assert.strictEqual(redirectedRequest.headers['content-length'], undefined);
		assert.strictEqual(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not forward body on cross-origin PUT redirect by default', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.put('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.all('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const redirectedRequest = await got.put('redirect', {
			body: 'request-data',
			headers: {
				'content-type': 'text/plain',
			},
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'PUT');
		assert.strictEqual(redirectedRequest.body, '');
		assert.strictEqual(redirectedRequest.headers['content-length'], '0');
		assert.strictEqual(redirectedRequest.headers['content-type'], undefined);
	});
});

for (const statusCode of [301, 302]) {
	test(`forwards body on cross-origin QUERY ${statusCode} redirect`, withServer, async (t, server1, got) => {
		await withServer(t, async (_t, server2) => {
			server1.all('/redirect', (_request, response) => {
				response.writeHead(statusCode, {
					location: `http://redirect-user:redirect-password@localhost:${server2.port}/`,
				});
				response.end();
			});

			server2.all('/', async (request, response) => {
				const chunks: Uint8Array[] = [];

				for await (const chunk of request) {
					chunks.push(Buffer.from(chunk));
				}

				response.end(JSON.stringify({
					method: request.method,
					body: Buffer.concat(chunks).toString(),
					headers: request.headers,
				}));
			});

			const redirectedRequest = await got.query('redirect', {
				json: {
					query: true,
				},
				headers: {
					authorization: 'Bearer secret',
					cookie: 'session=secret',
				},
				retry: {
					limit: 0,
				},
			}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

			assert.strictEqual(redirectedRequest.method, 'QUERY');
			assert.strictEqual(redirectedRequest.body, '{"query":true}');
			assert.strictEqual(redirectedRequest.headers['content-type'], 'application/json');
			assert.strictEqual(redirectedRequest.headers.authorization, undefined);
			assert.strictEqual(redirectedRequest.headers.cookie, undefined);
		});
	});

	test(`does not reuse streaming body on cross-origin QUERY ${statusCode} redirect`, withServer, async (t, server1, got) => {
		await withServer(t, async (_t, server2) => {
			let releaseSecondChunk!: () => void;
			const secondChunkReleased = new Promise<void>(resolve => {
				releaseSecondChunk = resolve;
			});

			server1.all('/redirect', (request, response) => {
				request.once('data', () => {
					request.pause();
					response.writeHead(statusCode, {
						location: `http://localhost:${server2.port}/`,
					});
					response.end();
				});
			});

			let redirectedOriginHits = 0;

			server2.all('/', (_request, response) => {
				redirectedOriginHits++;
				response.end();
			});

			async function * body(): AsyncGenerator<string> {
				yield 'consumed-by-redirect-origin';
				await secondChunkReleased;
				yield 'must-not-leak';
			}

			await assert.rejects(got.query('redirect', {
				body: Readable.from(body()),
				hooks: {
					beforeRedirect: [
						(options, response) => {
							assert.strictEqual(response.statusCode, statusCode);
							assert.strictEqual(options.method, 'QUERY');
							releaseSecondChunk();
						},
					],
				},
				retry: {
					limit: 0,
				},
			}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

			assert.strictEqual(redirectedOriginHits, 0);
		});
	});

	test(`beforeRedirect can replace non-replayable QUERY body on cross-origin ${statusCode} redirect`, withServer, async (t, server1, got) => {
		await withServer(t, async (_t, server2) => {
			server1.all('/redirect', (request, response) => {
				request.once('data', () => {
					request.pause();
					response.writeHead(statusCode, {
						location: `http://localhost:${server2.port}/`,
					});
					response.end();
				});
			});

			server2.all('/', async (request, response) => {
				const chunks: Uint8Array[] = [];

				for await (const chunk of request) {
					chunks.push(Buffer.from(chunk));
				}

				response.end(JSON.stringify({
					method: request.method,
					body: Buffer.concat(chunks).toString(),
				}));
			});

			const redirectedRequest = await got.query('redirect', {
				body: Readable.from(['original-body']),
				hooks: {
					beforeRedirect: [
						options => {
							options.body = 'replacement-body';
						},
					],
				},
				retry: {
					limit: 0,
				},
			}).json<{method: string; body: string}>();

			assert.strictEqual(redirectedRequest.method, 'QUERY');
			assert.strictEqual(redirectedRequest.body, 'replacement-body');
		});
	});

	test(`does not forward body when beforeRedirect changes ${statusCode} POST redirect to a different origin`, withServer, async (t, server1, got) => {
		await withServer(t, async (_t, server2) => {
			server1.post('/redirect', (_request, response) => {
				response.writeHead(statusCode, {
					location: '/',
				});
				response.end();
			});

			server2.all('/', async (request, response) => {
				const chunks: Uint8Array[] = [];

				for await (const chunk of request) {
					chunks.push(Buffer.from(chunk));
				}

				response.end(JSON.stringify({
					method: request.method,
					body: Buffer.concat(chunks).toString(),
					headers: request.headers,
				}));
			});

			const redirectedRequest = await got.post('redirect', {
				body: 'foobar',
				hooks: {
					beforeRedirect: [
						options => {
							options.url = new URL(server2.url);
						},
					],
				},
			}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

			assert.strictEqual(redirectedRequest.method, 'GET');
			assert.strictEqual(redirectedRequest.body, '');
			assert.strictEqual(redirectedRequest.headers['content-length'], undefined);
			assert.strictEqual(redirectedRequest.headers['content-type'], undefined);
		});
	});

	test(`forwards body when beforeRedirect changes ${statusCode} QUERY redirect to a different origin`, withServer, async (t, server1, got) => {
		await withServer(t, async (_t, server2) => {
			server1.all('/redirect', (_request, response) => {
				response.writeHead(statusCode, {
					location: '/',
				});
				response.end();
			});

			server2.all('/', async (request, response) => {
				const chunks: Uint8Array[] = [];

				for await (const chunk of request) {
					chunks.push(Buffer.from(chunk));
				}

				response.end(JSON.stringify({
					method: request.method,
					body: Buffer.concat(chunks).toString(),
					headers: request.headers,
				}));
			});

			const redirectedRequest = await got.query('redirect', {
				json: {
					query: true,
				},
				hooks: {
					beforeRedirect: [
						options => {
							options.url = new URL(server2.url);
						},
					],
				},
				retry: {
					limit: 0,
				},
			}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

			assert.strictEqual(redirectedRequest.method, 'QUERY');
			assert.strictEqual(redirectedRequest.body, '{"query":true}');
			assert.strictEqual(redirectedRequest.headers['content-type'], 'application/json');
		});
	});
}

test('forwards body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		// The request body and method are preserved per RFC, but sensitive headers are stripped.
		const redirectedRequest = await got.post('redirect', {
			body: 'request-data',
			headers: {
				authorization: 'secret-token',
				cookie: 'session=secret',
			},
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'POST');
						assert.strictEqual(options.body, 'request-data');
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'request-data');
		assert.strictEqual(redirectedRequest.headers['content-length'], String(Buffer.byteLength('request-data')));
		assert.strictEqual(redirectedRequest.headers.authorization, undefined);
		assert.strictEqual(redirectedRequest.headers.cookie, undefined);
	});
});

test('beforeRedirect can replace the body with an async iterable on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect-replaced-async-iterable', (_request, response) => {
			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
			}));
		});

		async function * replacementBody(): AsyncGenerator<string> {
			yield 'replacement-';
			yield 'body';
		}

		const redirectedRequest = await got.post('redirect-replaced-async-iterable', {
			body: 'request-data',
			hooks: {
				beforeRedirect: [
					options => {
						options.body = replacementBody();
						// The replacement is an async iterable of unknown length, so clear the
						// stale `content-length` from the original body and let it stream chunked.
						options.headers['content-length'] = undefined;
					},
				],
			},
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'replacement-body');
	});
});

test('forwards body on cross-origin 308 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(308, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		// The request body and method are preserved per RFC, but sensitive headers are stripped.
		const redirectedRequest = await got.post('redirect', {
			body: 'request-data',
			headers: {
				authorization: 'secret-token',
				cookie: 'session=secret',
			},
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'POST');
						assert.strictEqual(options.body, 'request-data');
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'request-data');
		assert.strictEqual(redirectedRequest.headers['content-length'], String(Buffer.byteLength('request-data')));
		assert.strictEqual(redirectedRequest.headers.authorization, undefined);
		assert.strictEqual(redirectedRequest.headers.cookie, undefined);
	});
});

test('does not reuse streaming body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		let releaseSecondChunk!: () => void;
		const secondChunkReleased = new Promise<void>(resolve => {
			releaseSecondChunk = resolve;
		});

		server1.post('/redirect', (request, response) => {
			request.once('data', () => {
				request.pause();
				response.writeHead(307, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
			});
		});

		let redirectedOriginHits = 0;

		server2.post('/', (_request, response) => {
			redirectedOriginHits++;
			response.end();
		});

		async function * body(): AsyncGenerator<string> {
			yield 'consumed-by-redirect-origin';
			await secondChunkReleased;
			yield 'must-not-leak';
		}

		await assert.rejects(got.post('redirect', {
			body: Readable.from(body()),
			hooks: {
				beforeRedirect: [
					(options, response) => {
						assert.strictEqual(response.statusCode, 307);
						assert.strictEqual(options.method, 'POST');
						releaseSecondChunk();
					},
				],
			},
			retry: {
				limit: 0,
			},
		}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

		assert.strictEqual(redirectedOriginHits, 0);
	});
});

test('does not reuse streaming body on cross-origin 308 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		let releaseSecondChunk!: () => void;
		const secondChunkReleased = new Promise<void>(resolve => {
			releaseSecondChunk = resolve;
		});

		server1.post('/redirect', (request, response) => {
			request.once('data', () => {
				request.pause();
				response.writeHead(308, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
			});
		});

		let redirectedOriginHits = 0;

		server2.post('/', (_request, response) => {
			redirectedOriginHits++;
			response.end();
		});

		async function * body(): AsyncGenerator<string> {
			yield 'consumed-by-redirect-origin';
			await secondChunkReleased;
			yield 'must-not-leak';
		}

		await assert.rejects(got.post('redirect', {
			body: Readable.from(body()),
			hooks: {
				beforeRedirect: [
					(options, response) => {
						assert.strictEqual(response.statusCode, 308);
						assert.strictEqual(options.method, 'POST');
						releaseSecondChunk();
					},
				],
			},
			retry: {
				limit: 0,
			},
		}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

		assert.strictEqual(redirectedOriginHits, 0);
	});
});

test('does not reuse Web ReadableStream body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', (request, response) => {
			request.once('data', () => {
				request.pause();
				response.writeHead(307, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
			});
		});

		let redirectedOriginHits = 0;

		server2.post('/', (_request, response) => {
			redirectedOriginHits++;
			response.end();
		});

		const textEncoder = new TextEncoder();
		const webReadableStream = new ReadableStream({
			start(controller) {
				controller.enqueue(textEncoder.encode('consumed-by-redirect-origin'));
			},
			async pull() {
				await new Promise(() => {});
			},
		});
		await assert.rejects(got.post('redirect', {
			body: webReadableStream,
			hooks: {
				beforeRedirect: [
					(options, response) => {
						assert.strictEqual(response.statusCode, 307);
						assert.strictEqual(options.method, 'POST');
					},
				],
			},
			retry: {
				limit: 0,
			},
		}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

		assert.strictEqual(redirectedOriginHits, 0);
	});
});

test('does not reuse one-shot iterable body on cross-origin 308 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(308, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		let redirectedOriginHits = 0;

		server2.post('/', (_request, response) => {
			redirectedOriginHits++;
			response.end();
		});

		let index = 0;
		const body = {
			next() {
				if (index === 0) {
					index++;

					return {
						value: 'consumed-by-redirect-origin',
						done: false,
					};
				}

				if (index === 1) {
					index++;

					return {
						value: 'must-not-leak',
						done: false,
					};
				}

				return {
					value: undefined,
					done: true,
				};
			},
			[Symbol.iterator]() {
				return this;
			},
		} satisfies IterableIterator<string>;
		await assert.rejects(got.post('redirect', {
			body,
			retry: {
				limit: 0,
			},
		}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

		assert.strictEqual(redirectedOriginHits, 0);
	});
});

test('does not reuse async iterable body on same-origin 307 redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', (request, response) => {
		request.once('data', () => {
			request.pause();
			response.writeHead(307, {
				location: '/destination',
			});
			response.end();
		});
	});

	let redirectDestinationHits = 0;

	server.post('/destination', (_request, response) => {
		redirectDestinationHits++;
		response.end();
	});

	let index = 0;
	let bodyReturned = false;
	const body = {
		async next() {
			if (index === 0) {
				index++;

				return {
					value: 'consumed-by-redirect-origin',
					done: false,
				};
			}

			return new Promise<IteratorResult<string>>(() => {});
		},
		async return() {
			bodyReturned = true;

			return {
				value: undefined,
				done: true,
			};
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	} satisfies AsyncIterableIterator<string>;
	await assert.rejects(got.post('redirect', {
		body,
		hooks: {
			beforeRedirect: [
				(options, response) => {
					assert.strictEqual(response.statusCode, 307);
					assert.strictEqual(options.method, 'POST');
				},
			],
		},
		retry: {
			limit: 0,
		},
	}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

	assert.strictEqual(redirectDestinationHits, 0);
	assert.strictEqual(bodyReturned, true);
});

test('beforeRedirect can replace a non-replayable body on same-origin 307 redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', (request, response) => {
		request.once('data', () => {
			request.pause();
			response.writeHead(307, {
				location: '/destination',
			});
			response.end();
		});
	});

	server.post('/destination', async (request, response) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}

		response.end(JSON.stringify({
			method: request.method,
			body: Buffer.concat(chunks).toString(),
		}));
	});

	let releaseSecondChunk!: () => void;
	const secondChunkReleased = new Promise<void>(resolve => {
		releaseSecondChunk = resolve;
	});

	let index = 0;
	let originalBodyReturned = false;
	const body = {
		async next() {
			if (index === 0) {
				index++;

				return {
					value: 'consumed-by-redirect-origin',
					done: false,
				};
			}

			if (index === 1) {
				index++;
				await secondChunkReleased;

				return {
					value: 'must-not-leak',
					done: false,
				};
			}

			return {
				value: undefined,
				done: true,
			};
		},
		async return() {
			originalBodyReturned = true;

			return {
				value: undefined,
				done: true,
			};
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	} satisfies AsyncIterableIterator<string>;

	async function * replacementBody(): AsyncGenerator<string> {
		yield 'replacement-';
		yield 'body';
	}

	const redirectedRequest = await got.post('redirect', {
		body,
		hooks: {
			beforeRedirect: [
				(options, response) => {
					assert.strictEqual(response.statusCode, 307);
					assert.strictEqual(options.method, 'POST');
					options.body = replacementBody();
					releaseSecondChunk();
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).json<{method: string; body: string}>();

	assert.strictEqual(redirectedRequest.method, 'POST');
	assert.strictEqual(redirectedRequest.body, 'replacement-body');
	assert.strictEqual(originalBodyReturned, true);
});

test('beforeRedirect destroys a non-replayable body removed on an early 307 redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.end(request.method);
		});
	});

	const originalBody = new Readable({
		read() {},
	});

	try {
		const {body} = await got.post('redirect', {
			body: originalBody,
			hooks: {
				beforeRedirect: [
					options => {
						options.body = undefined;
					},
				],
			},
			request(url, options, callback) {
				const request = http.request(url, options, callback);
				request.flushHeaders();
				return request;
			},
			retry: {
				limit: 0,
			},
		});

		assert.strictEqual(body, 'POST');
		assert.strictEqual(originalBody.destroyed, true);
	} finally {
		originalBody.destroy();
	}
});

test('beforeRedirect body removal persists across consecutive 307 redirects', withServer, async (_t, server, got) => {
	server.post('/first', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.writeHead(307, {
				location: '/second',
			});
			response.end();
		});
	});

	server.post('/second', (_request, response) => {
		response.writeHead(307, {
			location: '/final',
		});
		response.end();
	});

	server.post('/final', async (request, response) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}

		response.end(JSON.stringify({
			body: Buffer.concat(chunks).toString(),
			method: request.method,
		}));
	});

	let redirectCount = 0;
	const result = await got.post('first', {
		body: Readable.from(['original']),
		hooks: {
			beforeRedirect: [
				options => {
					redirectCount++;
					if (redirectCount === 1) {
						options.body = undefined;
					}
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).json<{body: string; method: string}>();

	assert.deepStrictEqual(result, {
		body: '',
		method: 'POST',
	});
	assert.strictEqual(redirectCount, 2);
});

test('beforeRedirect cancels a Web ReadableStream body removed on an early 307 redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', (request, response) => {
		request.resume();
		request.once('end', () => {
			response.end(request.method);
		});
	});

	let cancelled = false;
	const originalBody = new ReadableStream({
		async pull() {
			await new Promise(() => {});
		},
		cancel() {
			cancelled = true;
		},
	});

	const {body} = await got.post('redirect', {
		body: originalBody,
		hooks: {
			beforeRedirect: [
				options => {
					options.body = undefined;
				},
			],
		},
		request(url, options, callback) {
			const request = http.request(url, options, callback);
			request.flushHeaders();
			return request;
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, 'POST');
	assert.strictEqual(cancelled, true);
	assert.strictEqual(originalBody.locked, false);
});

test('beforeRedirect replacement body does not receive stale Node stream body chunks on 307 redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', (request, response) => {
		request.once('data', () => {
			request.pause();
			response.writeHead(307, {
				location: '/destination',
			});
			response.end();
		});
	});

	server.post('/destination', async (request, response) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}

		response.end(Buffer.concat(chunks).toString());
	});

	let releaseOriginalBody!: () => void;
	const originalBodyReleased = new Promise<void>(resolve => {
		releaseOriginalBody = resolve;
	});

	async function * originalBody(): AsyncGenerator<string> {
		yield 'consumed-by-redirect-origin';
		await originalBodyReleased;
		yield 'stale-original-body';
	}

	async function * replacementBody(): AsyncGenerator<string> {
		releaseOriginalBody();
		await delay(20);
		yield 'replacement-body';
	}

	const body = await got.post('redirect', {
		body: Readable.from(originalBody()),
		hooks: {
			beforeRedirect: [
				options => {
					options.body = replacementBody();
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).text();

	assert.strictEqual(body, 'replacement-body');
});

test('reuses replayable iterable body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
			}));
		});

		const redirectedRequest = await got.post('redirect', {
			body: ['replayable-', 'body'],
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'replayable-body');
	});
});

test('replays string body across consecutive cross-origin 307 redirects', withServer, async (t, server1, got) => {
	await withServer(t, async (t, server2) => {
		await withServer(t, async (_t, server3) => {
			server1.post('/redirect', async (request, response) => {
				await request.toArray();

				response.writeHead(307, {
					location: `http://localhost:${server2.port}/redirect-again`,
				});
				response.end();
			});

			server2.post('/redirect-again', async (request, response) => {
				await request.toArray();

				response.writeHead(307, {
					location: `http://localhost:${server3.port}/`,
				});
				response.end();
			});

			server3.post('/', async (request, response) => {
				const chunks: Uint8Array[] = [];

				for await (const chunk of request) {
					chunks.push(Buffer.from(chunk));
				}

				response.end(JSON.stringify({
					method: request.method,
					body: Buffer.concat(chunks).toString(),
					headers: request.headers,
				}));
			});

			const redirectedRequest = await got.post('redirect', {
				body: 'request-data',
				headers: {
					'content-type': 'text/plain',
				},
				retry: {
					limit: 0,
				},
			}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

			assert.strictEqual(redirectedRequest.method, 'POST');
			assert.strictEqual(redirectedRequest.body, 'request-data');
			assert.strictEqual(redirectedRequest.headers['content-length'], String(Buffer.byteLength('request-data')));
			assert.strictEqual(redirectedRequest.headers['content-type'], 'text/plain');
		});
	});
});

test('reuses replayable iterable promise chunks on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		let releaseSecondChunk!: (value: string) => void;
		const secondChunk = new Promise<string>(resolve => {
			releaseSecondChunk = resolve;
		});

		server1.post('/redirect', (request, response) => {
			request.once('data', () => {
				request.pause();
				response.writeHead(307, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
			});
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
			}));
		});

		const redirectedRequest = await got.post('redirect', {
			body: [
				Promise.resolve('replayable-'),
				secondChunk,
			] as unknown as Iterable<string>,
			hooks: {
				beforeRedirect: [
					(options, response) => {
						assert.strictEqual(response.statusCode, 307);
						assert.strictEqual(options.method, 'POST');
						releaseSecondChunk('body');
					},
				],
			},
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'replayable-body');
	});
});

test('reuses replayable async iterable body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
			}));
		});

		const body = {
			async * [Symbol.asyncIterator](): AsyncGenerator<string> {
				yield 'replayable-';
				yield 'body';
			},
		};

		const redirectedRequest = await got.post('redirect', {
			body,
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'replayable-body');
	});
});

test('reuses native FormData body on cross-origin 307 redirects', withServer, async (t, server1, got) => {
	await withServer(t, async (t, server2) => {
		await withServer(t, async (_t, server3) => {
			server1.post('/redirect', async (request, response) => {
				await request.toArray();

				response.writeHead(307, {
					location: `http://localhost:${server2.port}/redirect-again`,
				});
				response.end();
			});

			server2.post('/redirect-again', async (request, response) => {
				await request.toArray();

				response.writeHead(307, {
					location: `http://localhost:${server3.port}/`,
				});
				response.end();
			});

			server3.post('/', async (request, response) => {
				const chunks: Uint8Array[] = [];

				for await (const chunk of request) {
					chunks.push(Buffer.from(chunk));
				}

				response.end(JSON.stringify({
					method: request.method,
					body: Buffer.concat(chunks).toString(),
					headers: request.headers,
				}));
			});

			const form = new FormData();
			form.set('hello', 'world');

			const redirectedRequest = await got.post('redirect', {
				body: form,
				retry: {
					limit: 0,
				},
			}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

			const boundary = redirectedRequest.headers['content-type']?.match(/boundary=(?<boundary>.+)$/v)?.groups?.boundary;

			assert.strictEqual(redirectedRequest.method, 'POST');
			assert.strictEqual(redirectedRequest.headers['content-type']?.startsWith('multipart/form-data; boundary='), true);
			assert.ok(boundary);
			assert.strictEqual(redirectedRequest.body.includes(boundary), true);
			assert.strictEqual(redirectedRequest.body.includes('name="hello"'), true);
			assert.strictEqual(redirectedRequest.body.includes('world'), true);
		});
	});
});

test('native FormData 307 redirect preserves explicit Content-Length', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		if (request.headers['content-length'] === undefined || request.headers['transfer-encoding'] !== undefined) {
			response.status(411).end();
			return;
		}

		const body = Buffer.concat(await request.toArray()).toString();
		response.json({
			body,
			contentLength: request.headers['content-length'],
			transferEncoding: request.headers['transfer-encoding'],
		});
	});

	const form = new FormData();
	form.set('hello', 'world');
	const contentLength = await getFormDataContentLength(form);

	const redirectedRequest = await got.post('redirect', {
		body: form,
		headers: {
			'content-length': contentLength,
		},
		retry: {
			limit: 0,
		},
	}).json<{body: string; contentLength: string; transferEncoding?: string}>();

	assert.strictEqual(redirectedRequest.contentLength, contentLength);
	assert.strictEqual(redirectedRequest.transferEncoding, undefined);
	assert.strictEqual(redirectedRequest.body.includes('name="hello"'), true);
	assert.strictEqual(redirectedRequest.body.includes('world'), true);
});

test('native FormData 308 redirect preserves case-insensitive explicit Content-Length', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(308, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		await request.toArray();
		response.json(request.headers);
	});

	const form = new FormData();
	form.set('hello', 'world');
	const contentLength = await getFormDataContentLength(form);

	const headers = await got.post('redirect', {
		body: form,
		headers: {
			'Content-Length': contentLength,
		},
		retry: {
			limit: 0,
		},
	}).json<Record<string, string | undefined>>();

	assert.strictEqual(headers['content-length'], contentLength);
	assert.strictEqual(headers['transfer-encoding'], undefined);
});

test('native FormData preserves explicit Content-Length across consecutive redirects', withServer, async (_t, server, got) => {
	const receivedContentLengths: Array<string | undefined> = [];
	const receivedTransferEncodings: Array<string | undefined> = [];

	server.post('/redirect', async (request, response) => {
		receivedContentLengths.push(request.headers['content-length']);
		receivedTransferEncodings.push(request.headers['transfer-encoding']);
		await request.toArray();

		response.writeHead(307, {
			location: '/redirect-again',
		});
		response.end();
	});

	server.post('/redirect-again', async (request, response) => {
		receivedContentLengths.push(request.headers['content-length']);
		receivedTransferEncodings.push(request.headers['transfer-encoding']);
		await request.toArray();

		response.writeHead(308, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		receivedContentLengths.push(request.headers['content-length']);
		receivedTransferEncodings.push(request.headers['transfer-encoding']);
		await request.toArray();
		response.end();
	});

	const form = new FormData();
	form.set('hello', 'world');
	const contentLength = await getFormDataContentLength(form);
	await got.post('redirect', {
		body: form,
		headers: {
			'content-length': contentLength,
		},
		retry: {
			limit: 0,
		},
	});

	assert.deepStrictEqual(receivedContentLengths, [contentLength, contentLength, contentLength]);
	assert.deepStrictEqual(receivedTransferEncodings, [undefined, undefined, undefined]);
});

test('native FormData redirect preserves explicit Content-Length when beforeRedirect does not replace the body', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		await request.toArray();
		response.end(request.headers['content-length']);
	});

	const form = new FormData();
	form.set('hello', 'world');
	const contentLength = await getFormDataContentLength(form);

	const body = await got.post('redirect', {
		body: form,
		headers: {
			'content-length': contentLength,
		},
		hooks: {
			beforeRedirect: [
				options => {
					options.headers.accept = 'text/plain';
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).text();

	assert.strictEqual(body, contentLength);
});

test('native FormData redirect recalculates Content-Length when beforeRedirect replaces the body', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', (request, response) => {
		response.end(request.headers['content-length']);
	});

	const form = new FormData();
	form.set('hello', 'world');
	const contentLength = await getFormDataContentLength(form);

	const body = await got.post('redirect', {
		body: form,
		headers: {
			'content-length': contentLength,
		},
		hooks: {
			beforeRedirect: [
				options => {
					options.body = 'hi';
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).text();

	assert.strictEqual(body, '2');
});

test('native FormData 307 redirect respects content-type changed in beforeRedirect hook', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		await request.toArray();

		response.end(request.headers['content-type']);
	});

	const form = new FormData();
	form.set('hello', 'world');

	const body = await got.post('redirect', {
		body: form,
		hooks: {
			beforeRedirect: [
				options => {
					options.headers['content-type'] = 'text/plain';
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).text();

	assert.strictEqual(body, 'text/plain');
});

test('native FormData 307 redirects preserve content-type changed in beforeRedirect hook', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/redirect-again',
		});
		response.end();
	});

	server.post('/redirect-again', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		await request.toArray();

		response.end(request.headers['content-type']);
	});

	const form = new FormData();
	form.set('hello', 'world');

	let redirects = 0;
	const body = await got.post('redirect', {
		body: form,
		hooks: {
			beforeRedirect: [
				options => {
					redirects++;
					if (redirects === 1) {
						options.headers['content-type'] = 'text/plain';
					}
				},
			],
		},
		retry: {
			limit: 0,
		},
	}).text();

	assert.strictEqual(body, 'text/plain');
});

test('forwards json body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const redirectedRequest = await got.post('redirect', {
			json: {secret: true},
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'POST');
						assert.strictEqual(options.body, '{"secret":true}');
						assert.strictEqual(options.json, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, '{"secret":true}');
		assert.strictEqual(redirectedRequest.headers['content-type'], 'application/json');
	});
});

test('forwards form body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', async (request, response) => {
			await request.toArray();

			response.writeHead(307, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const redirectedRequest = await got.post('redirect', {
			form: {secret: 'data'},
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'POST');
						assert.strictEqual(options.body, 'secret=data');
						assert.strictEqual(options.form, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'POST');
		assert.strictEqual(redirectedRequest.body, 'secret=data');
		assert.strictEqual(redirectedRequest.headers['content-type'], 'application/x-www-form-urlencoded');
	});
});

test('preserves body on same-origin 307 redirect', withServer, async (_t, server, got) => {
	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}

		response.end(JSON.stringify({
			method: request.method,
			body: Buffer.concat(chunks).toString(),
		}));
	});

	const redirectedRequest = await got.post('redirect', {
		body: 'keep-this',
		hooks: {
			beforeRedirect: [
				options => {
					assert.strictEqual(options.method, 'POST');
					assert.strictEqual(options.body, 'keep-this');
				},
			],
		},
	}).json<{method: string; body: string}>();

	assert.strictEqual(redirectedRequest.method, 'POST');
	assert.strictEqual(redirectedRequest.body, 'keep-this');
});

test('does not follow 304 responses with a location header', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		let attackerHits = 0;

		server1.post('/redirect', (_request, response) => {
			response.writeHead(304, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			attackerHits++;

			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const response = await got.post('redirect', {
			body: 'foobar',
			throwHttpErrors: false,
		});

		assert.strictEqual(response.statusCode, 304);
		assert.strictEqual(response.body, '');
		assert.deepStrictEqual(response.redirectUrls, []);
		assert.strictEqual(attackerHits, 0);
	});
});

test('does not follow 300 responses with a location header', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		let attackerHits = 0;

		server1.post('/redirect', (_request, response) => {
			response.writeHead(300, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.post('/', async (request, response) => {
			attackerHits++;

			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const response = await got.post('redirect', {
			body: 'foobar',
			throwHttpErrors: false,
		});

		assert.strictEqual(response.statusCode, 300);
		assert.strictEqual(response.body, '');
		assert.deepStrictEqual(response.redirectUrls, []);
		assert.strictEqual(attackerHits, 0);
	});
});

test('preserves body on same-origin permanent POST redirect by default', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(301, {
			location: '/',
		});
		response.end();
	});

	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const {body} = await got.post('redirect', {
		body: 'foobar',
		hooks: {
			beforeRedirect: [
				options => {
					assert.strictEqual(options.method, 'POST');
					assert.strictEqual(options.body, 'foobar');
				},
			],
		},
	});

	assert.strictEqual(body, 'foobar');
});

test('preserves body when redirect only adds an explicit default port', async _t => {
	let isFirstRequest = true;

	const redirectedRequest = await got.post('http://example.com/start', {
		body: 'foobar',
		hooks: {
			beforeRequest: [
				options => {
					const requestUrl = options.url?.toString();
					if (requestUrl === undefined) {
						throw new Error('Expected redirect request URL');
					}

					if (isFirstRequest) {
						isFirstRequest = false;

						return new Responselike({
							statusCode: 302,
							headers: {
								location: 'http://example.com:80/next',
							},
							body: Buffer.alloc(0),
							url: requestUrl,
						});
					}

					return new Responselike({
						statusCode: 200,
						headers: {
							'content-type': 'application/json',
						},
						body: Buffer.from(JSON.stringify({
							method: options.method,
							body: options.body,
						})),
						url: requestUrl,
					});
				},
			],
		},
	}).json<{method: string; body: string}>();

	assert.strictEqual(redirectedRequest.method, 'POST');
	assert.strictEqual(redirectedRequest.body, 'foobar');
});

test('large body is preserved on 307 redirect', withServer, async (_t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 2, 'a');

	server.post('/redirect', async (request, response) => {
		await request.toArray();

		response.writeHead(307, {
			location: '/target',
		});
		response.end();
	});

	server.post('/target', async (request, response) => {
		const receivedChunks: Uint8Array[] = [];

		for await (const receivedChunk of request) {
			receivedChunks.push(Buffer.from(receivedChunk));
		}

		const receivedBody = Buffer.concat(receivedChunks);

		assert.strictEqual(receivedBody.equals(requestBody), true);
		response.end('ok');
	});

	const {body} = await got.post('redirect', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, 'ok');
});

test('injected request close before response emits pending request abort error', withServer, async (_t, server, got) => {
	server.get('/pending-close', (_request, _response) => {
		// Keep request open until client-side close is injected below.
	});

	const pendingRequest = got('pending-close').on('request', clientRequest => {
		// Simulate the pre-response close edge case directly on the request object.
		clientRequest.emit('close');
	});

	const error = await rejects(pendingRequest, errorMatching(RequestError, {message: 'The server aborted pending request'}));

	assert.strictEqual(error?.code, 'ECONNRESET');
});

test('method rewriting', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	server.post('/permanentRedirect', (_request, response) => {
		response.writeHead(301, {
			location: '/',
		});
		response.end();
	});

	server.get('/', (_request, response) => {
		response.end();
	});

	server.post('/temporaryRedirect', (_request, response) => {
		response.writeHead(307, {
			location: '/',
		});
		response.end();
	});
	server.post('/', (request, response) => {
		request.pipe(response);
	});

	const {body} = await got.post('redirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					assert.strictEqual(options.body, undefined);
				},
			],
		},
	});

	assert.strictEqual(body, '');

	const {body: permanentRedirectBody} = await got.post('permanentRedirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					assert.strictEqual(options.method, 'GET');
					assert.strictEqual(options.body, undefined);
				},
			],
		},
	});

	assert.strictEqual(permanentRedirectBody, '');

	// Do not rewrite method on 307 or 308
	const {body: temporaryRedirectBody} = await got.post('temporaryRedirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					assert.strictEqual(options.body, 'foobar');
				},
			],
		},
	});

	assert.strictEqual(temporaryRedirectBody, 'foobar');
});

test('upload progress total is reset on redirected GET request', withServer, async (_t, server, got) => {
	server.post('/redirect-upload-progress', (_request, response) => {
		response.writeHead(303, {
			location: '/redirect-upload-progress-target',
		});
		response.end();
	});
	server.get('/redirect-upload-progress-target', (_request, response) => {
		response.end('ok');
	});

	const events: Array<{transferred: number; total: number | undefined}> = [];
	const requestMethods: string[] = [];
	const {body} = await got.post('redirect-upload-progress', {
		body: 'foobar',
		retry: {
			limit: 0,
		},
	}).on('request', request => {
		requestMethods.push(request.method ?? '');
	}).on('uploadProgress', event => {
		events.push({
			transferred: event.transferred,
			total: event.total,
		});
	});

	assert.strictEqual(body, 'ok');
	assert.deepStrictEqual(requestMethods, ['POST', 'GET']);

	const zeroTransferredEvents = events.filter(event => event.transferred === 0);
	assert.strictEqual(zeroTransferredEvents.length >= 2, true);

	const redirectedRequestEvents = zeroTransferredEvents.slice(-2);
	assert.deepStrictEqual(redirectedRequestEvents, [
		{transferred: 0, total: undefined},
		{transferred: 0, total: 0},
	]);
});

test('clears username and password when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			username: 'hello',
			password: 'world',
		}).json<{headers: Record<string, string | undefined>}>();
		assert.strictEqual(headers.authorization, undefined);
	});
});

test('clears the authorization header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				authorization: 'Basic aGVsbG86d29ybGQ=',
			},
		}).json<{headers: Record<string, string | undefined>}>();
		assert.strictEqual(headers.authorization, undefined);
	});
});

test('clears the proxy-authorization header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				'proxy-authorization': 'Basic aGVsbG86d29ybGQ=',
			},
		}).json<{headers: Record<string, string | undefined>}>();
		assert.strictEqual(headers['proxy-authorization'], undefined);
	});
});

test('clears the cookie2 header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				cookie2: 'v=1',
			},
		}).json<{headers: Record<string, string | undefined>}>();
		assert.strictEqual(headers.cookie2, undefined);
	});
});

test('clears credentials and sensitive headers when redirecting to a different protocol on the same hostname', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer(t, async (_t, serverHttp) => {
		serverHttps.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://${serverHttp.hostname}:${serverHttp.port}/target`,
			});
			response.end();
		});

		serverHttp.get('/target', (request, response) => {
			response.end(JSON.stringify(request.headers));
		});

		const headers = await got('', {
			username: 'hello',
			password: 'world',
			headers: {
				cookie: 'session=123',
			},
		}).json<Record<string, string | undefined>>();

		assert.strictEqual(headers.authorization, undefined);
		assert.strictEqual(headers.cookie, undefined);
	});
});

test('does not forward body when redirecting to a different protocol on the same hostname', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer(t, async (_t, serverHttp) => {
		serverHttps.post('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://${serverHttp.hostname}:${serverHttp.port}/target`,
			});
			response.end();
		});

		serverHttp.get('/target', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
				headers: request.headers,
			}));
		});

		const redirectedRequest = await got.post('', {
			body: 'foobar',
			https: {
				rejectUnauthorized: false,
			},
			hooks: {
				beforeRedirect: [
					options => {
						assert.strictEqual(options.method, 'GET');
						assert.strictEqual(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		assert.strictEqual(redirectedRequest.method, 'GET');
		assert.strictEqual(redirectedRequest.body, '');
		assert.strictEqual(redirectedRequest.headers['content-type'], undefined);
	});
});

test('preserves userinfo on redirect to the same origin', withServer, async (_t, server) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(303, {
			location: `http://localhost:${server.port}/`,
		});
		response.end();
	});

	server.get('/', (request, response) => {
		assert.strictEqual(request.headers.authorization, 'Basic aGVsbG86d29ybGQ=');
		response.end();
	});
	await got(`http://hello:world@localhost:${server.port}/redirect`);
});

test('strips credentials embedded in cross-origin redirect Location URL', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://injected:creds@localhost:${server2.port}/target`,
			});
			response.end();
		});

		server2.get('/target', (request, response) => {
			response.end(JSON.stringify({authorization: request.headers.authorization}));
		});

		const body = await got('').json<{authorization: string | undefined}>();
		assert.strictEqual(body.authorization, undefined);
	});
});

test('strips credentials embedded in cross-origin redirect Location URL on 307', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(307, {
				location: `http://injected:creds@localhost:${server2.port}/target`,
			});
			response.end();
		});

		server2.get('/target', (request, response) => {
			response.end(JSON.stringify({authorization: request.headers.authorization}));
		});

		const body = await got('').json<{authorization: string | undefined}>();
		assert.strictEqual(body.authorization, undefined);
	});
});

test('strips both user-supplied and Location-embedded credentials on cross-origin redirect', withServer, async (t, server1) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `http://injected:creds@localhost:${server2.port}/target`,
			});
			response.end();
		});

		server2.get('/target', (request, response) => {
			response.end(JSON.stringify({authorization: request.headers.authorization}));
		});

		const body = await got(`http://hello:world@localhost:${server1.port}/`).json<{authorization: string | undefined}>();
		assert.strictEqual(body.authorization, undefined);
	});
});

test('clears the host header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: `http://localhost:${server2.port}/`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(request.headers.host);
		});

		const resp = await got('redirect', {headers: {host: 'wrongsite.com'}});
		assert.strictEqual(resp.body, `localhost:${server2.port}`);
	});
});

test('correct port on redirect', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/redirect', (_request, response) => {
			response.redirect(`http://${server2.hostname}:${server2.port}/`);
		});

		server1.get('/', (_request, response) => {
			response.end('SERVER1');
		});

		server2.get('/', (_request, response) => {
			response.end('SERVER2');
		});

		const response = await got(`${server1.url}/redirect`, {prefixUrl: ''});

		assert.strictEqual(response.body, 'SERVER2');
	});
});

test('downloadProgress does not fire for redirect responses', withServer, async (_t, server, got) => {
	const body = Buffer.alloc(1024);

	server.get('/', (_request, response) => {
		response.writeHead(200, {
			'content-length': body.length,
		});
		response.end(body);
	});

	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/',
			'content-length': '0',
		});
		response.end();
	});

	const progressEvents: Array<{transferred: number; total?: number}> = [];
	await got('redirect', {responseType: 'buffer'})
		.on('downloadProgress', event => {
			progressEvents.push({transferred: event.transferred, total: event.total});
		});

	// Should have at least 2 events: initial and final
	// All events should be for the final response (total = 1024), not the redirect
	assert.strictEqual(progressEvents.length >= 2, true);

	// First event should be initial progress for final response
	assert.strictEqual(progressEvents[0]?.transferred, 0);
	assert.strictEqual(progressEvents[0]?.total, 1024);

	// Last event should be completion
	const lastEvent = progressEvents.at(-1)!;
	assert.strictEqual(lastEvent.transferred, 1024);
	assert.strictEqual(lastEvent.total, 1024);

	// All events should have total = 1024 (the final response size, not 0 from redirect)
	for (const event of progressEvents) {
		assert.strictEqual(event.total, 1024);
	}
});

test('strips sensitive headers when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			// Same-origin redirect: headers are preserved
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				authorization: 'Bearer secret',
				cookie: 'session=abc',
				cookie2: 'legacy=val',
				'proxy-authorization': 'Basic proxy',
			},
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(headers.authorization, undefined);
		assert.strictEqual(headers.cookie, undefined);
		assert.strictEqual(headers.cookie2, undefined);
		assert.strictEqual(headers['proxy-authorization'], undefined);
	});
});

test('preserves replacement authorization header when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				authorization: 'Bearer original-secret',
			},
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
						options.headers.authorization = 'Bearer replacement-secret';
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(headers.authorization, 'Bearer replacement-secret');
	});
});

test('preserves explicitly reapplied authorization header when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				authorization: 'Bearer same-secret',
			},
			hooks: {
				beforeRedirect: [
					options => {
						const {authorization} = options.headers;
						options.url = new URL(`http://localhost:${server2.port}/`);
						options.headers.authorization = authorization;
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(headers.authorization, 'Bearer same-secret');
	});
});

test('strips sensitive headers when beforeRedirect hook reassigns headers object without reapplying them', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			headers: {
				authorization: 'Bearer same-secret',
				cookie: 'session=abc',
			},
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
						options.headers = {
							...options.headers,
							foo: 'bar',
						};
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(headers.authorization, undefined);
		assert.strictEqual(headers.cookie, undefined);
		assert.strictEqual(headers.foo, 'bar');
	});
});

test('preserves headers when beforeRedirect hook keeps the same origin', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: `${server.url}/step2`,
		});
		response.end();
	});

	server.get('/other', (request, response) => {
		response.end(JSON.stringify({headers: request.headers}));
	});

	const {headers} = await got('', {
		headers: {
			authorization: 'Bearer keep-me',
		},
		hooks: {
			beforeRedirect: [
				options => {
					options.url = new URL(`${server.url}/other`);
				},
			],
		},
	}).json<{headers: Record<string, string | undefined>}>();

	assert.strictEqual(headers.authorization, 'Bearer keep-me');
});

test('preserves replacement credentials when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			username: 'old-user',
			password: 'old-password',
			hooks: {
				beforeRedirect: [
					options => {
						const url = options.url!;
						url.port = String(server2.port);
						url.pathname = '/';
						url.username = 'new-user';
						url.password = 'new-password';
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(headers.authorization, 'Basic bmV3LXVzZXI6bmV3LXBhc3N3b3Jk');
	});
});

test('preserves replacement credentials from options.username and options.password when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({headers: request.headers}));
		});

		const {headers} = await got('', {
			username: 'old-user',
			password: 'old-password',
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
						options.username = 'new-user';
						options.password = 'new-password';
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(headers.authorization, 'Basic bmV3LXVzZXI6bmV3LXBhc3N3b3Jk');
	});
});

test('strips sensitive headers when beforeRedirect hook mutates the existing URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			response.writeHead(307, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.post('/', (request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				body += chunk.toString();
			});

			request.on('end', () => {
				response.end(JSON.stringify({
					headers: request.headers,
					body,
				}));
			});
		});

		const result = await got.post('', {
			headers: {
				authorization: 'Bearer secret',
				cookie: 'session=abc',
			},
			body: 'request body',
			hooks: {
				beforeRedirect: [
					options => {
						const url = options.url!;
						url.port = String(server2.port);
						url.pathname = '/';
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(result.headers.authorization, undefined);
		assert.strictEqual(result.headers.cookie, undefined);
		// The body is preserved on 307, even when a hook changes the origin.
		assert.strictEqual(result.body, 'request body');
	});
});

test('preserves body when beforeRedirect hook changes URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			// 307 preserves method and body, even when a hook later changes the origin.
			response.writeHead(307, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.post('/', (request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				body += chunk.toString();
			});

			request.on('end', () => {
				response.end(JSON.stringify({
					method: request.method,
					headers: request.headers,
					body,
				}));
			});
		});

		const result = await got.post('', {
			json: {secret: 'data'},
			headers: {
				authorization: 'secret-token',
			},
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
					},
				],
			},
		}).json<{method: string; headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(result.method, 'POST');
		assert.strictEqual(result.body, '{"secret":"data"}');
		assert.strictEqual(result.headers['content-type'], 'application/json');
		assert.strictEqual(result.headers.authorization, undefined);
	});
});

test('preserves replacement body when beforeRedirect hook changes URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			response.writeHead(307, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.post('/', (request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				body += chunk.toString();
			});

			request.on('end', () => {
				response.end(JSON.stringify({
					method: request.method,
					headers: request.headers,
					body,
				}));
			});
		});

		const result = await got.post('', {
			body: 'old-data',
			headers: {
				'content-type': 'text/plain',
			},
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
						options.body = 'new-data';
						options.headers['content-type'] = 'text/plain';
					},
				],
			},
		}).json<{method: string; headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(result.method, 'POST');
		assert.strictEqual(result.body, 'new-data');
		assert.strictEqual(result.headers['content-type'], 'text/plain');
	});
});

test('preserves replacement body when beforeRedirect hook mutates the existing URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			response.writeHead(307, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.post('/', (request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				body += chunk.toString();
			});

			request.on('end', () => {
				response.end(JSON.stringify({
					method: request.method,
					headers: request.headers,
					body,
				}));
			});
		});

		const result = await got.post('', {
			body: 'old-data',
			headers: {
				'content-type': 'text/plain',
			},
			hooks: {
				beforeRedirect: [
					options => {
						const url = options.url!;
						url.port = String(server2.port);
						url.pathname = '/';
						options.body = 'new-data';
						options.headers['content-type'] = 'text/plain';
					},
				],
			},
		}).json<{method: string; headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(result.method, 'POST');
		assert.strictEqual(result.body, 'new-data');
		assert.strictEqual(result.headers['content-type'], 'text/plain');
	});
});

test('preserves explicitly reassigned same body when beforeRedirect hook mutates the existing URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			response.writeHead(307, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.post('/', (request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				body += chunk.toString();
			});

			request.on('end', () => {
				response.end(JSON.stringify({
					method: request.method,
					headers: request.headers,
					body,
				}));
			});
		});

		const result = await got.post('', {
			body: 'same-data',
			headers: {
				'content-type': 'text/plain',
			},
			hooks: {
				beforeRedirect: [
					options => {
						const url = options.url!;
						url.port = String(server2.port);
						url.pathname = '/';
						options.body = 'same-data';
						options.headers['content-type'] = 'text/plain';
					},
				],
			},
		}).json<{method: string; headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(result.method, 'POST');
		assert.strictEqual(result.body, 'same-data');
		assert.strictEqual(result.headers['content-type'], 'text/plain');
	});
});

test('preserves in-place body rewrite when beforeRedirect hook mutates the existing URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			response.writeHead(307, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.post('/', (request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => { // eslint-disable-line @typescript-eslint/no-restricted-types
				body += chunk.toString();
			});

			request.on('end', () => {
				response.end(JSON.stringify({
					method: request.method,
					headers: request.headers,
					body,
				}));
			});
		});

		const result = await got.post('', {
			body: Buffer.from('old-data'),
			headers: {
				'content-type': 'text/plain',
			},
			hooks: {
				beforeRedirect: [
					options => {
						const url = options.url!;
						url.port = String(server2.port);
						url.pathname = '/';
						(options.body as Uint8Array).set(Buffer.from('new-data'));
						options.headers['content-type'] = 'text/plain';
					},
				],
			},
		}).json<{method: string; headers: Record<string, string | undefined>; body: string}>();

		assert.strictEqual(result.method, 'POST');
		assert.strictEqual(result.body, 'new-data');
		assert.strictEqual(result.headers['content-type'], 'text/plain');
	});
});

test('preserves replacement URL credentials when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({
				headers: request.headers,
				url: request.url,
			}));
		});

		const result = await got('', {
			username: 'user',
			password: 'pass',
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://evil:hacker@localhost:${server2.port}/`);
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(result.headers.authorization, `Basic ${Buffer.from('evil:hacker').toString('base64')}`);
	});
});

test('preserves explicit URL object credentials when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({
				headers: request.headers,
			}));
		});

		const result = await got('', {
			username: 'user',
			password: 'pass',
			hooks: {
				beforeRedirect: [
					options => {
						const nextUrl = new URL(options.url!);
						nextUrl.protocol = 'http:';
						nextUrl.hostname = 'localhost';
						nextUrl.port = String(server2.port);
						nextUrl.pathname = '/';
						options.url = nextUrl;
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(result.headers.authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
	});
});

test('preserves explicit URL object username when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({
				headers: request.headers,
			}));
		});

		const result = await got('', {
			username: 'user',
			hooks: {
				beforeRedirect: [
					options => {
						const nextUrl = new URL(options.url!);
						nextUrl.protocol = 'http:';
						nextUrl.hostname = 'localhost';
						nextUrl.port = String(server2.port);
						nextUrl.pathname = '/';
						options.url = nextUrl;
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(result.headers.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);
	});
});

test('strips inherited password when explicit URL object keeps only username during beforeRedirect cross-origin change', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.get('/', (_request, response) => {
			response.writeHead(302, {
				location: `${server1.url}/step2`,
			});
			response.end();
		});

		server2.get('/', (request, response) => {
			response.end(JSON.stringify({
				headers: request.headers,
			}));
		});

		const result = await got('', {
			username: 'user',
			password: 'pass',
			hooks: {
				beforeRedirect: [
					options => {
						const nextUrl = new URL(options.url!);
						nextUrl.protocol = 'http:';
						nextUrl.hostname = 'localhost';
						nextUrl.port = String(server2.port);
						nextUrl.pathname = '/';
						nextUrl.password = '';
						options.url = nextUrl;
					},
				],
			},
		}).json<{headers: Record<string, string | undefined>}>();

		assert.strictEqual(result.headers.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);
	});
});

for (const statusCode of [301, 302]) {
	test(`does not send an empty body on same-origin ${statusCode} redirect with a non-replayable body`, withServer, async (_t, server, got) => {
		let destinationHits = 0;

		server.post('/redirect', (request, response) => {
			request.resume();
			request.once('end', () => {
				response.writeHead(statusCode, {
					location: '/destination',
				});
				response.end();
			});
		});

		server.post('/destination', (request, response) => {
			destinationHits++;
			request.resume();
			response.end();
		});
		await assert.rejects(got.post('redirect', {
			body: Readable.from(['hello', ' world']),
			retry: {
				limit: 0,
			},
		}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));

		assert.strictEqual(destinationHits, 0);
	});

	test(`drops a non-replayable body when beforeRedirect changes a ${statusCode} redirect to another origin`, withServer, async (t, server1, got) => {
		await withServer(t, async (_t, server2) => {
			server1.post('/redirect', (request, response) => {
				request.resume();
				request.once('end', () => {
					response.writeHead(statusCode, {
						location: '/unused',
					});
					response.end();
				});
			});

			server2.get('/destination', (request, response) => {
				response.end(request.method);
			});

			const {body} = await got.post('redirect', {
				body: Readable.from(['hello', ' world']),
				hooks: {
					beforeRedirect: [
						options => {
							options.url = new URL('destination', server2.url);
						},
					],
				},
				retry: {
					limit: 0,
				},
			});

			assert.strictEqual(body, 'GET');
		});
	});
}

test('beforeRedirect destroys a replacement body dropped after a cross-origin 302 rewrite', withServer, async (t, server1, got) => {
	await withServer(t, async (_t, server2) => {
		server1.post('/redirect', (request, response) => {
			request.resume();
			request.once('end', () => {
				response.writeHead(302, {
					location: '/unused',
				});
				response.end();
			});
		});

		server2.get('/destination', (request, response) => {
			response.end(request.method);
		});

		const replacementBody = new Readable({
			read() {},
		});

		try {
			const {body} = await got.post('redirect', {
				body: 'original',
				hooks: {
					beforeRedirect: [
						options => {
							options.url = new URL('destination', server2.url);
							options.body = replacementBody;
						},
					],
				},
				retry: {
					limit: 0,
				},
			});

			assert.strictEqual(body, 'GET');
			assert.strictEqual(replacementBody.destroyed, true);
		} finally {
			replacementBody.destroy();
		}
	});
});

test('redirect inherits the fragment of the original URL', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', reachedHandler);

	const {url, redirectUrls} = await got('redirect#section');
	assert.strictEqual(url, `${server.url}/final#section`);
	assert.strictEqual(redirectUrls[0]!.href, `${server.url}/final#section`);
});

test('redirect inherits a fragment ending in a hash', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', reachedHandler);

	const {url, redirectUrls} = await got('redirect#section#');
	assert.strictEqual(url, `${server.url}/final#section#`);
	assert.strictEqual(redirectUrls[0]!.href, `${server.url}/final#section#`);
});

test('redirect keeps the fragment of the Location header', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final#other',
		});
		response.end();
	});

	server.get('/final', reachedHandler);

	const {url} = await got('redirect#section');
	assert.strictEqual(url, `${server.url}/final#other`);
});

test('redirect clears the fragment when the Location header has an empty fragment', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/final#',
		});
		response.end();
	});

	server.get('/final', reachedHandler);

	const {url, redirectUrls} = await got('redirect#section');
	assert.strictEqual(url, `${server.url}/final#`);
	assert.strictEqual(redirectUrls[0]!.href, `${server.url}/final#`);
});

test('redirect inherits an empty fragment from the previous redirect', withServer, async (_t, server, got) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(302, {
			location: '/middle#',
		});
		response.end();
	});

	server.get('/middle', (_request, response) => {
		response.writeHead(302, {
			location: '/final',
		});
		response.end();
	});

	server.get('/final', reachedHandler);

	const {url, redirectUrls} = await got('redirect#section');
	assert.strictEqual(url, `${server.url}/final#`);
	assert.deepStrictEqual(redirectUrls.map(url => url.href), [
		`${server.url}/middle#`,
		`${server.url}/final#`,
	]);
});

test('beforeRedirect body replacement updates Content-Length', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}

		response.end(Buffer.concat(chunks).toString());
	});

	const replacement = 'this is a much longer body than before!!';

	const {body} = await got.post('redirect', {
		body: 'hello',
		hooks: {
			beforeRedirect: [
				options => {
					options.body = replacement;
				},
			],
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, replacement);
});

test('beforeRedirect shorter body replacement updates Content-Length', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	// Assert on the received header instead of the body: with a stale
	// Content-Length the server would keep waiting for the missing bytes.
	server.post('/destination', (request, response) => {
		response.end(String(request.headers['content-length']));
	});

	const {body} = await got.post('redirect', {
		body: 'this is a much longer body than before!!',
		hooks: {
			beforeRedirect: [
				options => {
					options.body = 'hi';
				},
			],
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, '2');
});

test('beforeRedirect stream body replacement removes Content-Length', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', async (request, response) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}

		response.end(Buffer.concat(chunks).toString());
	});

	function * replacement(): Generator<string> {
		yield 'streamed-';
		yield 'body';
	}

	const {body} = await got.post('redirect', {
		body: 'hello',
		hooks: {
			beforeRedirect: [
				options => {
					options.body = replacement();
				},
			],
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, 'streamed-body');
});

test('beforeRedirect explicit Content-Length is preserved', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {
			location: '/destination',
		});
		response.end();
	});

	server.post('/destination', (request, response) => {
		response.end(String(request.headers['content-length']));
	});

	const {body} = await got.post('redirect', {
		body: 'hello',
		hooks: {
			beforeRedirect: [
				options => {
					options.body = 'hi';
					options.headers['content-length'] = '2';
				},
			],
		},
		retry: {
			limit: 0,
		},
	});

	assert.strictEqual(body, '2');
});

// RFC 3986 section 5 resolves references against the current request URI; RFC 9110 section 10.2.2 adds fragment inheritance.
for (const {name, location, expectedTarget, expectedFragment} of [
	{
		name: 'sibling path', location: 'next', expectedTarget: '/a/b/next', expectedFragment: '#original',
	},
	{
		name: 'parent path', location: '../next', expectedTarget: '/a/next', expectedFragment: '#original',
	},
	{
		name: 'dot segments', location: './temporary/../next/', expectedTarget: '/a/b/next/', expectedFragment: '#original',
	},
	{
		name: 'query-only reference', location: '?page=2', expectedTarget: '/a/b/start?page=2', expectedFragment: '#original',
	},
	{
		name: 'empty query', location: '?', expectedTarget: '/a/b/start?', expectedFragment: '#original',
	},
	{
		name: 'fragment-only reference', location: '#next', expectedTarget: '/a/b/start?old=1', expectedFragment: '#next',
	},
	{
		name: 'empty fragment-only reference', location: '#', expectedTarget: '/a/b/start?old=1', expectedFragment: '#',
	},
	{
		name: 'encoded path delimiters', location: 'part%2Fname%3Fvalue%23tag', expectedTarget: '/a/b/part%2Fname%3Fvalue%23tag', expectedFragment: '#original',
	},
	{
		name: 'encoded percent sign', location: 'part%252Fname', expectedTarget: '/a/b/part%252Fname', expectedFragment: '#original',
	},
	{
		name: 'query delimiters and repeated values', location: '?value=a%26b%3Dc&value=d+e', expectedTarget: '/a/b/start?value=a%26b%3Dc&value=d+e', expectedFragment: '#original',
	},
	{
		name: 'dot segments inside a query', location: 'next?path=/one/../two', expectedTarget: '/a/b/next?path=/one/../two', expectedFragment: '#original',
	},
	{
		name: 'encoded fragment', location: 'next#part%23two', expectedTarget: '/a/b/next', expectedFragment: '#part%23two',
	},
]) {
	test(`Location URI resolution preserves ${name}`, withServer, async (_t, server, got) => {
		const targets: string[] = [];
		server.use((request, response) => {
			targets.push(request.url);
			if (targets.length === 1) {
				response.writeHead(302, {location}).end();
				return;
			}

			response.end('reached');
		});
		const response = await got('a/b/start?old=1#original');

		assert.strictEqual(response.body, 'reached');
		// Node's native HTTP client omits an empty query delimiter from the request target.
		const wireTarget = expectedTarget.endsWith('?') ? expectedTarget.slice(0, -1) : expectedTarget;
		assert.deepStrictEqual(targets, ['/a/b/start?old=1', wireTarget]);
		assert.strictEqual(response.url, `${server.url}${expectedTarget}${expectedFragment}`);
		assert.deepStrictEqual(response.redirectUrls.map(url => url.href), [response.url]);
		assert.strictEqual(response.requestUrl.href, `${server.url}/a/b/start?old=1#original`);
	});
}

test('relative Location references use each redirect as the next base URI', withServer, async (_t, server, got) => {
	const targets: string[] = [];
	const locations = ['../next/item?step=1#updated', '?step=2', './final'];
	server.use((request, response) => {
		targets.push(request.url);
		const location = locations[targets.length - 1];
		if (location !== undefined) {
			response.writeHead(302, {location}).end();
			return;
		}

		response.end('reached');
	});
	const response = await got('a/b/start?old=1#original');

	assert.deepStrictEqual(targets, ['/a/b/start?old=1', '/a/next/item?step=1', '/a/next/item?step=2', '/a/next/final']);
	assert.deepStrictEqual(response.redirectUrls.map(url => url.href), [
		`${server.url}/a/next/item?step=1#updated`,
		`${server.url}/a/next/item?step=2#updated`,
		`${server.url}/a/next/final#updated`,
	]);
	assert.strictEqual(response.url, `${server.url}/a/next/final#updated`);
});

for (const {statusCode, method, methodRewriting, expectedMethod, expectedBody} of [
	{
		statusCode: 303, method: 'PATCH', methodRewriting: false, expectedMethod: 'GET', expectedBody: '',
	},
	{
		statusCode: 308, method: 'PUT', methodRewriting: true, expectedMethod: 'PUT', expectedBody: 'updated content',
	},
]) {
	test(`${statusCode} redirect applies ${method} method semantics with methodRewriting ${methodRewriting}`, withServer, async (_t, server, got) => {
		const methods: string[] = [];
		const bodies: string[] = [];
		server.use(async (request, response) => {
			methods.push(request.method);
			const chunks = await request.toArray();
			bodies.push(chunks.join(''));
			if (methods.length === 1) {
				response.writeHead(statusCode, {location: '/destination'}).end();
				return;
			}

			response.end('reached');
		});
		const response = await got('start', {method, methodRewriting, body: 'updated content'});

		assert.strictEqual(response.body, 'reached');
		assert.deepStrictEqual(methods, [method, expectedMethod]);
		assert.deepStrictEqual(bodies, ['updated content', expectedBody]);
		assert.strictEqual(response.request.options.method, expectedMethod);
	});
}

test('a stopped redirect keeps the first predicate decision', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/next'});
		response.end('stopped');
	});
	let calls = 0;
	const response = await got('', {
		followRedirect() {
			calls++;
			return calls > 1;
		},
	});

	assert.strictEqual(response.statusCode, 302);
	assert.strictEqual(response.body, 'stopped');
	assert.strictEqual(response.ok, true);
	assert.strictEqual(calls, 1);
});

for (const {stream, compressed} of [{stream: true, compressed: false}, {stream: false, compressed: true}, {stream: true, compressed: true}]) {
	test(`stopped redirect predicate runs once with stream=${stream} and compressed=${compressed}`, withServer, async (_t, server, got) => {
		const bytes = compressed ? await gzipAsync('stopped') : Buffer.from('stopped');
		server.get('/', (_request, response) => {
			response.writeHead(302, {location: '/next', ...(compressed && {'content-encoding': 'gzip'})});
			response.end(bytes);
		});
		let calls = 0;
		const options = {
			followRedirect() {
				calls++;
				return calls > 1;
			},
		};
		const body = stream ? await getStream(got.stream('', options)) : await got('', options).text();

		assert.strictEqual(body, 'stopped');
		assert.strictEqual(calls, 1);
	});
}

test('a stopped redirect still reports JSON parsing errors without asking the predicate again', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/next'});
		response.end('invalid JSON');
	});
	let calls = 0;
	const error = await rejects(got('', {
		responseType: 'json',
		followRedirect() {
			calls++;
			return calls > 1;
		},
	}), ParseError);

	assert.strictEqual(error.response.statusCode, 302);
	assert.strictEqual(error.response.body, 'invalid JSON');
	assert.strictEqual(calls, 1);
});

test('each redirect hop makes its own predicate decision', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/first'}).end('first');
	});
	server.get('/first', (_request, response) => {
		response.writeHead(302, {location: '/second'}).end('second');
	});
	server.get('/second', (_request, response) => {
		response.writeHead(302, {location: '/unused'}).end('stopped');
	});
	const paths: string[] = [];
	const response = await got('', {
		followRedirect(response) {
			paths.push(new URL(response.url).pathname);
			return paths.length < 3;
		},
	});

	assert.deepStrictEqual(paths, ['/', '/first', '/second']);
	assert.strictEqual(response.body, 'stopped');
	assert.strictEqual(response.redirectUrls.length, 2);
	assert.strictEqual(response.ok, true);
});

test('retries evaluate the same configured redirect predicate for each new response', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.writeHead(302, {location: '/unused'}).end(String(requests));
	});
	let calls = 0;
	const response = await got('', {
		retry: {limit: 1, backoffLimit: 0, noise: 0},
		followRedirect() {
			calls++;
			return false;
		},
		hooks: {
			afterResponse: [response => {
				if (response.body === '1') {
					response.statusCode = 503;
				}

				return response;
			}],
		},
	});

	assert.strictEqual(requests, 2);
	assert.strictEqual(calls, 2);
	assert.strictEqual(response.body, '2');
	assert.strictEqual(response.retryCount, 1);
	assert.strictEqual(response.ok, true);
});

test('a hook can replace the redirect predicate without reusing the old decision', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/unused'}).end('stopped');
	});
	let originalCalls = 0;
	let replacementCalls = 0;
	const response = await got('', {
		followRedirect() {
			originalCalls++;
			return false;
		},
		hooks: {
			afterResponse: [response => {
				response.request.options.followRedirect = () => {
					replacementCalls++;
					return false;
				};

				return response;
			}],
		},
	});

	assert.strictEqual(originalCalls, 1);
	assert.strictEqual(replacementCalls, 1);
	assert.strictEqual(response.ok, true);
});

test('a hook can replace the redirect predicate with a boolean policy', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/unused'}).end('stopped');
	});
	let calls = 0;
	const error = await rejects(got('', {
		followRedirect() {
			calls++;
			return false;
		},
		hooks: {
			afterResponse: [response => {
				response.request.options.followRedirect = true;
				return response;
			}],
		},
	}), HTTPError);

	assert.strictEqual(calls, 1);
	assert.strictEqual(error.response.statusCode, 302);
	assert.strictEqual(error.response.ok, false);
});

for (const statusCode of [301, 302, 303, 307, 308]) {
	for (const methodRewriting of [false, true]) {
		test(`HEAD stays HEAD after ${statusCode} with methodRewriting ${methodRewriting}`, withServer, async (_t, server, got) => {
			const methods: string[] = [];
			server.use((request, response) => {
				methods.push(request.method);
				if (request.url === '/start') {
					response.writeHead(statusCode, {location: '/end'}).end();
					return;
				}

				response.end('representation');
			});

			const response = await got.head('start', {methodRewriting});

			assert.deepStrictEqual(methods, ['HEAD', 'HEAD']);
			assert.strictEqual(response.body, '');
			assert.strictEqual(response.request.options.method, 'HEAD');
		});
	}
}

test('response timeout starts after a replacement stream upload on redirect', withServer, async (_t, server, got) => {
	server.put('/', (request, response) => {
		request.resume();
		request.on('end', () => {
			response.redirect(307, '/next');
		});
	});
	server.put('/next', request => {
		request.resume();
	});

	const error = await rejects(got.put('', {
		body: Readable.from(['first']),
		retry: {limit: 0},
		// `request` only exists so a request that somehow completes is still bounded. The test
		// asserts the `response` timeout, which is the one that has to fire, so the request budget
		// is set far above it rather than close enough for a slow machine to spend it first.
		timeout: {response: 100, request: 10_000},
		hooks: {
			beforeRedirect: [options => {
				options.body = Readable.from(['second']);
			}],
		},
	}), TimeoutError);

	assert.strictEqual(error?.event, 'response');
});

for (const statusCode of [307, 308]) {
	test(`replacement streams report uploaded bytes after a ${statusCode} redirect`, withServer, async (_t, server, got) => {
		const bodies: string[] = [];
		server.put('/', async (request, response) => {
			bodies.push((await request.toArray()).join(''));
			response.redirect(statusCode, '/next');
		});
		server.put('/next', async (request, response) => {
			bodies.push((await request.toArray()).join(''));
			response.end('done');
		});

		const response = await got.put('', {
			body: Readable.from(['first']),
			retry: {limit: 0},
			hooks: {
				beforeRedirect: [options => {
					options.body = Readable.from(['longer ', 'replacement']);
				}],
			},
		});

		assert.deepStrictEqual(bodies, ['first', 'longer replacement']);
		assert.deepStrictEqual(response.request.uploadProgress, {percent: 1, transferred: 18, total: 18});
	});
}

test('same-origin POST with methodRewriting false and Readable body rejects on 301', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(301, {location: '/destination'});
		response.end();
	});

	server.post('/destination', (_request, response) => {
		response.end();
	});
	await assert.rejects(got.post('redirect', {
		body: Readable.from(['payload']),
		methodRewriting: false,
		retry: {limit: 0},
	}), errorMatching(RequestError, {message: 'Cannot follow redirect with a non-replayable body'}));
});

test('beforeRedirect hook removing string body on 307 sends no body to destination', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(307, {location: '/destination'});
		response.end();
	});

	let receivedBody = 'NOT_SET';
	let receivedContentLength: string | undefined;
	server.post('/destination', (request, response) => {
		receivedContentLength = request.headers['content-length'];
		let data = '';
		request.on('data', (chunk: Uint8Array) => {
			data += Buffer.from(chunk).toString();
		});
		request.on('end', () => {
			receivedBody = data;
			response.end();
		});
	});
	await got.post('redirect', {
		body: 'original body',
		hooks: {
			beforeRedirect: [options => {
				options.body = undefined;
			}],
		},
		retry: {limit: 0},
	});

	assert.strictEqual(receivedBody, '');
	// Node sends Content-Length: 0 for a bodyless POST, so a stale length from the removed body would show up here.
	assert.strictEqual(receivedContentLength, '0');
});

test('beforeRedirect replacing string body on 308 updates content-length to new byte length', withServer, async (_t, server, got) => {
	server.post('/redirect', (_request, response) => {
		response.writeHead(308, {location: '/destination'});
		response.end();
	});

	server.post('/destination', (request, response) => {
		response.end(request.headers['content-length'] ?? '');
	});

	const newBody = 'much longer replacement body!!';
	const {body} = await got.post('redirect', {
		body: 'hi',
		hooks: {
			beforeRedirect: [options => {
				options.body = newBody;
			}],
		},
		retry: {limit: 0},
	});

	assert.strictEqual(body, String(Buffer.byteLength(newBody)));
});

test('followRedirect function is called once per redirect hop and not for the final 200', withServer, async (_t, server, got) => {
	server.get('/first', (_request, response) => {
		response.writeHead(302, {location: '/second'}).end();
	});
	server.get('/second', (_request, response) => {
		response.writeHead(302, {location: '/final'}).end();
	});
	server.get('/final', (_request, response) => {
		response.end('done');
	});

	let calls = 0;
	const response = await got('first', {
		followRedirect() {
			calls++;
			return true;
		},
	});

	assert.strictEqual(response.body, 'done');
	assert.strictEqual(calls, 2);
});

test('followRedirect is only called for redirect responses', withServer, async (_t, server, got) => {
	const seen: number[] = [];
	server.get('/ok', (_request, response) => {
		response.end('ok');
	});
	server.get('/missing', (_request, response) => {
		response.statusCode = 404;
		response.end('missing');
	});
	server.get('/not-modified', (_request, response) => {
		response.statusCode = 304;
		response.end();
	});
	server.get('/temporary', (_request, response) => {
		response.writeHead(302, {location: '/ok'}).end();
	});

	const followRedirect: NonNullable<Options['followRedirect']> = response => {
		seen.push(response.statusCode);
		return true;
	};

	await got('ok', {followRedirect});
	await assert.rejects(got('missing', {followRedirect}), HTTPError);
	await got('not-modified', {followRedirect});
	await got('temporary', {followRedirect});

	// Only the 3xx response consults the predicate, and only once.
	assert.deepStrictEqual(seen, [302]);
});

test('followRedirect is called once for a compressed redirect that is not followed', withServer, async (_t, server, got) => {
	server.get('/', async (_request, response) => {
		response.writeHead(302, {'content-encoding': 'gzip'});
		response.end(await gzipAsync('redirect body'));
	});

	let calls = 0;
	const response = await got('', {
		followRedirect() {
			calls++;
			return false;
		},
	});

	assert.strictEqual(response.statusCode, 302);
	assert.strictEqual(response.body, 'redirect body');
	assert.strictEqual(calls, 1);
});

const echoUrl: Handler = (request, response) => {
	response.end(request.url);
};

test('a protocol-relative redirect keeps the URL semantics of the Location authority', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '//127.0.0.1/final'});
		response.end();
	});

	server.get('/final', echoUrl);

	// `//127.0.0.1/final` carries its own authority without a port, so the redirect targets
	// the default port per URL semantics and cannot reach this server.
	const error = await rejects(got('', {retry: {limit: 0}}), {code: 'ECONNREFUSED'});
	assert.ok(error);
});

test('a Location header with a space is percent-encoded and followed', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {location: '/with space'});
		response.end();
	});

	server.use(echoUrl);

	const {body} = await got('');
	assert.strictEqual(body, '/with%20space');
});

test('duplicate Location headers follow the first value', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('location', ['/first', '/second']);
		response.statusCode = 302;
		response.end();
	});

	server.get('/first', echoUrl);
	server.get('/second', () => {
		throw new Error('The second Location must not be followed');
	});

	const {body} = await got('');
	assert.strictEqual(body, '/first');
});
