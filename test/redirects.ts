import {Buffer} from 'node:buffer';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {gzip} from 'node:zlib';
import test from 'ava';
import type {Handler} from 'express';
import Responselike from 'responselike';
import got, {MaxRedirectsError, RequestError} from '../source/index.js';
import withServer, {withHttpsServer} from './helpers/with-server.js';

const gzipAsync = promisify(gzip);

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

test('cannot redirect to UNIX protocol when UNIX sockets are enabled', withServer, async (t, server, got) => {
	server.get('/protocol', unixProtocol);
	server.get('/hostname', unixHostname);
	server.get('/protocol-without-socket-path', unixProtocolWithoutSocketPath);

	const gotUnixSocketsEnabled = got.extend({enableUnixSockets: true});

	t.true(gotUnixSocketsEnabled.defaults.options.enableUnixSockets);

	await t.throwsAsync(gotUnixSocketsEnabled('protocol'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});

	await t.throwsAsync(gotUnixSocketsEnabled('hostname'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});

	await t.throwsAsync(gotUnixSocketsEnabled('protocol-without-socket-path'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});
});

test('cannot redirect to UNIX protocol when UNIX sockets are not enabled', withServer, async (t, server, got) => {
	server.get('/protocol', unixProtocol);
	server.get('/hostname', unixHostname);
	server.get('/protocol-without-socket-path', unixProtocolWithoutSocketPath);

	const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

	t.false(gotUnixSocketsDisabled.defaults.options.enableUnixSockets);

	await t.throwsAsync(gotUnixSocketsDisabled('protocol'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});

	await t.throwsAsync(gotUnixSocketsDisabled('hostname'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});

	await t.throwsAsync(gotUnixSocketsDisabled('protocol-without-socket-path'), {
		message: 'Cannot redirect to UNIX socket',
		instanceOf: RequestError,
	});
});

test('follows redirect to ordinary http://unix host', withServer, async (t, server, got) => {
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

	t.is(body, 'reached');
	t.deepEqual(redirectUrls.map(String), [`http://unix:${server.port}/foo`]);
});

test('follows redirect', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite');
	t.is(body, 'reached');
	t.deepEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('does not follow redirect when followRedirect is a function and returns false', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, statusCode} = await got('finite', {followRedirect: () => false});
	t.not(body, 'reached');
	t.is(statusCode, 302);
});

test('follows redirect when followRedirect is a function and returns true', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {body, redirectUrls} = await got('finite', {followRedirect: () => true});
	t.is(body, 'reached');
	t.deepEqual(redirectUrls.map(String), [`${server.url}/`]);
});

test('followRedirect gets plainResponse and does not follow', withServer, async (t, server, got) => {
	server.get('/temporary', (_request, response) => {
		response.writeHead(307, {
			location: '/redirect',
		});
		response.end();
	});

	const {statusCode} = await got('temporary', {
		followRedirect(response) {
			t.is(response.headers.location, '/redirect');
			return false;
		},
	});
	t.is(statusCode, 307);
});

test('follows 307, 308 redirect', withServer, async (t, server, got) => {
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
	t.is(temporaryBody, 'reached');

	const permBody = (await got('permanent')).body;
	t.is(permBody, 'reached');
});

test('does not follow redirect when disabled', withServer, async (t, server, got) => {
	server.get('/', finiteHandler);

	t.is((await got({followRedirect: false})).statusCode, 302);
});

test('ignores invalid compressed redirect bodies when following redirects', withServer, async (t, server, got) => {
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

	t.is(response.body, 'target-ok');
});

test('followRedirect runs before redirect body decompression', withServer, async (t, server, got) => {
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
				t.is(response.headers.location, '/target');
				t.is(String(response.requestUrl), `${server.url}/redirect`);
			}

			return true;
		},
	});

	t.true(sawRedirectResponse);
	t.is(response.body, 'target-ok');
});

test('decompresses compressed redirect bodies when redirects are not followed', withServer, async (t, server, got) => {
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

	t.is(response.statusCode, 302);
	t.is(response.body, 'redirect-body');
});

test('relative redirect works', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	t.is((await got('relative')).body, 'reached');
});

test('throws on endless redirects - default behavior', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url,
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got(''), {message: 'Redirected 10 times. Aborting.'});

	t.deepEqual(error?.response.redirectUrls.map(String), Array.from({length: 10}).fill(`${server.url}/`));
	t.is(error?.code, 'ERR_TOO_MANY_REDIRECTS');
});

test('custom `maxRedirects` option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: server.url,
		});
		response.end();
	});

	const error = await t.throwsAsync<MaxRedirectsError>(got('', {maxRedirects: 5}), {message: 'Redirected 5 times. Aborting.'});

	t.deepEqual(error?.response.redirectUrls.map(String), Array.from({length: 5}).fill(`${server.url}/`));
	t.is(error?.code, 'ERR_TOO_MANY_REDIRECTS');
});

test('searchParams are not breaking redirects', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.get('/relativeSearchParam', (request, response) => {
		t.is(request.query.bang, '1');

		response.writeHead(302, {
			location: '/',
		});
		response.end();
	});

	t.is((await got('relativeSearchParam', {searchParams: 'bang=1'})).body, 'reached');
});

test('redirects GET and HEAD requests', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});

	await t.throwsAsync(got.get(''), {
		instanceOf: MaxRedirectsError,
		code: 'ERR_TOO_MANY_REDIRECTS',
	});
});

test('redirects POST requests', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(308, {
			location: '/',
		});
		response.end();
	});

	await t.throwsAsync(got.post({body: 'wow'}), {
		instanceOf: MaxRedirectsError,
		code: 'ERR_TOO_MANY_REDIRECTS',
	});
});

test('redirects on 303 if GET or HEAD', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.head('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {url, headers, request} = await got.head('seeOther');
	t.is(url, `${server.url}/`);
	t.is(headers['content-length'], 'reached'.length.toString());
	t.is(request.options.method, 'HEAD');
});

test('removes body on GET redirect', withServer, async (t, server, got) => {
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
	t.is(body, '');
	t.is(headers['content-length'], '0');
});

test('removes request body headers on GET redirect', withServer, async (t, server, got) => {
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

	t.is(method, 'GET');
	t.is(headers['content-length'], undefined);
	t.is(headers['content-type'], undefined);
	t.is(headers['content-language'], undefined);
	t.is(headers['content-location'], undefined);
	t.is(headers['content-encoding'], undefined);
});

test('redirects on 303 response even on post, put, delete', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);

	server.post('/seeOther', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	const {url, body} = await got.post('seeOther', {body: 'wow'});
	t.is(url, `${server.url}/`);
	t.is(body, 'reached');
});

test('redirects from http to https work', withServer, async (t, serverHttp) => {
	await withHttpsServer().exec(t, async (t, serverHttps, got) => {
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

		t.is((await got('httpToHttps', {
			prefixUrl: serverHttp.url,
		})).body, 'https');
	});
});

test('redirects from https to http work', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer.exec(t, async (t, serverHttp) => {
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

		t.is((await got('httpsToHttp', {
			prefixUrl: serverHttps.url,
		})).body, 'http');
	});
});

test('redirects works with lowercase method', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/relative', relativeHandler);

	const {body} = await got('relative', {method: 'head'});
	t.is(body, '');
});

test('redirect response contains new url', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {url} = await got('finite');
	t.is(url, `${server.url}/`);
});

test('redirect response contains old url', withServer, async (t, server, got) => {
	server.get('/', reachedHandler);
	server.get('/finite', finiteHandler);

	const {requestUrl} = await got('finite');
	t.is(requestUrl.toString(), `${server.url}/finite`);
});

test('redirect response contains UTF-8 with binary encoding', withServer, async (t, server, got) => {
	server.get('/utf8-url-%C3%A1%C3%A9', reachedHandler);

	server.get('/redirect-with-utf8-binary', (_request, response) => {
		response.writeHead(302, {
			location: Buffer.from((new URL('/utf8-url-áé', server.url)).toString(), 'utf8').toString('binary'),
		});
		response.end();
	});

	t.is((await got('redirect-with-utf8-binary')).body, 'reached');
});

test('redirect response contains UTF-8 with URI encoding', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		t.is(request.query.test, 'it’s ok');
		response.end('reached');
	});

	server.get('/redirect-with-uri-encoded-location', (_request, response) => {
		response.writeHead(302, {
			location: new URL('/?test=it’s+ok', server.url).toString(),
		});
		response.end();
	});

	t.is((await got('redirect-with-uri-encoded-location')).body, 'reached');
});

test('throws on invalid redirect URL', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(302, {
			location: 'http://',
		});
		response.end();
	});

	await t.throwsAsync(got(''), {
		code: 'ERR_INVALID_URL',
	});
});

test('redirect uses port from redirect URL, not from original request', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(body, 'ok');
	});
});

test('body is reset on GET redirect', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.writeHead(303, {
			location: '/',
		});
		response.end();
	});

	server.get('/', (_request, response) => {
		response.end();
	});

	await got.post('', {
		body: 'foobar',
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				},
			],
		},
	});

	await got.post('', {
		json: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				},
			],
		},
	});

	await got.post('', {
		form: {foo: 'bar'},
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, undefined);
				},
			],
		},
	});
});

test('body is passed on POST redirect', withServer, async (t, server, got) => {
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
					t.is(options.body, 'foobar');
				},
			],
		},
	});

	t.is(body, 'foobar');
});

test('does not forward body on cross-origin POST redirect by default', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
						t.is(options.method, 'GET');
						t.is(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'GET');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not forward body on cross-origin permanent POST redirect by default', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
						t.is(options.method, 'GET');
						t.is(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'GET');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-length'], undefined);
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not forward body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
		server1.post('/redirect', async (request, response) => {
			for await (const chunk of request) {
				void chunk;
			}

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
			body: 'sensitive-data',
			hooks: {
				beforeRedirect: [
					options => {
						t.is(options.method, 'POST');
						t.is(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not fail when dropping a streaming body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		let redirectUpload: () => void;
		const redirected = new Promise<void>(resolve => {
			redirectUpload = resolve;
		});
		let redirectHandled!: () => void;
		const redirectProcessed = new Promise<void>(resolve => {
			redirectHandled = resolve;
		});
		let bodyDisposed!: () => void;
		const bodyDisposedPromise = new Promise<void>(resolve => {
			bodyDisposed = resolve;
		});

		server1.post('/redirect-stream', (request, response) => {
			let redirectedResponse = false;

			request.on('data', () => {
				if (redirectedResponse) {
					return;
				}

				redirectedResponse = true;
				response.writeHead(307, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
				redirectUpload();
			});

			request.resume();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			await bodyDisposedPromise;

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
			}));
		});

		const requestBody = new PassThrough();
		requestBody.once('close', () => {
			bodyDisposed();
		});

		const responsePromise = got.post('redirect-stream', {
			body: requestBody,
			hooks: {
				beforeRedirect: [
					() => {
						redirectHandled();
					},
				],
			},
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string}>();

		requestBody.write('sensitive-');
		await redirected;
		await redirectProcessed;
		await Promise.race([
			bodyDisposedPromise,
			(async () => {
				await delay(1000);
				throw new Error('Dropped stream body was not disposed');
			})(),
		]);

		const redirectedRequest = await responsePromise;
		t.true(requestBody.destroyed);
		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
	});
});

test('does not forward piped writable stream body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		let redirectHandled!: () => void;
		const redirectProcessed = new Promise<void>(resolve => {
			redirectHandled = resolve;
		});

		server1.post('/redirect-piped-stream', (request, response) => {
			let redirectedResponse = false;

			request.on('data', () => {
				if (redirectedResponse) {
					return;
				}

				redirectedResponse = true;
				response.writeHead(307, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
			});

			request.resume();
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

		const requestStream = got.stream.post('redirect-piped-stream', {
			hooks: {
				beforeRedirect: [
					() => {
						redirectHandled();
					},
				],
			},
			retry: {
				limit: 0,
			},
		});
		const writableFinished = new Promise<void>(resolve => {
			requestStream.once('finish', resolve);
		});

		const responsePromise = (async () => {
			let responseBody = '';

			for await (const chunk of requestStream) {
				responseBody += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
			}

			return JSON.parse(responseBody) as {method: string; body: string};
		})();

		const source = new PassThrough();
		source.pipe(requestStream);

		source.write('sensitive-');
		await redirectProcessed;
		source.end('data');

		const [redirectedRequest] = await Promise.all([
			responsePromise,
			Promise.race([
				writableFinished,
				(async () => {
					await delay(1000);
					throw new Error('Redirected writable stream did not finish');
				})(),
			]),
		]);
		t.true(requestStream.writableFinished);
		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
	});
});

test('beforeRedirect can replace stripped body with an async iterable on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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
			body: 'sensitive-data',
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
		}).json<{method: string; body: string}>();

		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, 'replacement-body');
	});
});

test('does not fail when dropping an async iterable body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		let redirectUpload: () => void;
		const redirected = new Promise<void>(resolve => {
			redirectUpload = resolve;
		});
		let redirectHandled!: () => void;
		const redirectProcessed = new Promise<void>(resolve => {
			redirectHandled = resolve;
		});
		let releaseBeforeRedirect!: () => void;
		const beforeRedirectDelay = new Promise<void>(resolve => {
			releaseBeforeRedirect = resolve;
		});
		let secondChunkRequested!: () => void;
		const secondChunkPullStarted = new Promise<void>(resolve => {
			secondChunkRequested = resolve;
		});
		let lateBodyErrorSeen!: () => void;
		const lateBodyError = new Promise<void>(resolve => {
			lateBodyErrorSeen = resolve;
		});
		let rejectSecondChunk!: (error: Error) => void;
		const secondChunk = new Promise<string>((_resolve, reject) => {
			rejectSecondChunk = error => {
				reject(error);
				lateBodyErrorSeen();
			};
		});

		server1.post('/redirect-async-iterable', (request, response) => {
			let redirectedResponse = false;

			request.on('data', () => {
				if (redirectedResponse) {
					return;
				}

				redirectedResponse = true;
				setTimeout(() => {
					response.writeHead(307, {
						location: `http://localhost:${server2.port}/`,
					});
					response.end();
					redirectUpload();
				}, 20);
			});

			request.resume();
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

		async function * requestBody(): AsyncGenerator<string> {
			yield 'sensitive-';
			secondChunkRequested();
			yield await secondChunk;
		}

		const responsePromise = got.post('redirect-async-iterable', {
			body: requestBody(),
			hooks: {
				beforeRedirect: [
					async () => {
						redirectHandled();
						await beforeRedirectDelay;
					},
				],
			},
			retry: {
				limit: 0,
			},
		}).json<{method: string; body: string}>();

		await secondChunkPullStarted;
		await redirected;
		await redirectProcessed;
		rejectSecondChunk(new Error('late body failure'));
		await lateBodyError;
		releaseBeforeRedirect();

		const redirectedRequest = await responsePromise;
		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
	});
});

test('cancels dropped async iterable body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		let cancelBody!: () => void;
		const canceled = new Promise<void>(resolve => {
			cancelBody = resolve;
		});
		let yieldedFirstChunk = false;

		server1.post('/redirect-cancel-async-iterable', (request, response) => {
			let redirectedResponse = false;

			request.on('data', () => {
				if (redirectedResponse) {
					return;
				}

				redirectedResponse = true;
				response.writeHead(307, {
					location: `http://localhost:${server2.port}/`,
				});
				response.end();
			});

			request.resume();
		});

		server2.post('/', async (request, response) => {
			const chunks: Uint8Array[] = [];

			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}

			await canceled;

			response.end(JSON.stringify({
				method: request.method,
				body: Buffer.concat(chunks).toString(),
			}));
		});

		const requestBody = {
			async next() {
				if (!yieldedFirstChunk) {
					yieldedFirstChunk = true;
					return {
						done: false,
						value: 'sensitive-data',
					};
				}

				return new Promise<IteratorResult<string>>(() => {});
			},
			async return() {
				cancelBody();
				return {
					done: true,
					value: undefined,
				};
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};

		const redirectedRequest = await Promise.race([
			got.post('redirect-cancel-async-iterable', {
				body: requestBody,
				retry: {
					limit: 0,
				},
			}).json<{method: string; body: string}>(),
			(async () => {
				await delay(1000);
				throw new Error('Dropped async iterable was not cancelled');
			})(),
		]);

		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
	});
});

test('does not forward body on cross-origin 308 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
		server1.post('/redirect', async (request, response) => {
			for await (const chunk of request) {
				void chunk;
			}

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

		const redirectedRequest = await got.post('redirect', {
			body: 'sensitive-data',
			hooks: {
				beforeRedirect: [
					options => {
						t.is(options.method, 'POST');
						t.is(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not forward json body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
		server1.post('/redirect', async (request, response) => {
			for await (const chunk of request) {
				void chunk;
			}

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
						t.is(options.method, 'POST');
						t.is(options.body, undefined);
						t.is(options.json, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('does not forward form body on cross-origin 307 redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
		server1.post('/redirect', async (request, response) => {
			for await (const chunk of request) {
				void chunk;
			}

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
						t.is(options.method, 'POST');
						t.is(options.body, undefined);
						t.is(options.form, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'POST');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('preserves body on same-origin 307 redirect', withServer, async (t, server, got) => {
	server.post('/redirect', async (request, response) => {
		for await (const chunk of request) {
			void chunk;
		}

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
					t.is(options.method, 'POST');
					t.is(options.body, 'keep-this');
				},
			],
		},
	}).json<{method: string; body: string}>();

	t.is(redirectedRequest.method, 'POST');
	t.is(redirectedRequest.body, 'keep-this');
});

test('does not follow 304 responses with a location header', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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

		t.is(response.statusCode, 304);
		t.is(response.body, '');
		t.deepEqual(response.redirectUrls, []);
		t.is(attackerHits, 0);
	});
});

test('does not follow 300 responses with a location header', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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

		t.is(response.statusCode, 300);
		t.is(response.body, '');
		t.deepEqual(response.redirectUrls, []);
		t.is(attackerHits, 0);
	});
});

test('preserves body on same-origin permanent POST redirect by default', withServer, async (t, server, got) => {
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
					t.is(options.method, 'POST');
					t.is(options.body, 'foobar');
				},
			],
		},
	});

	t.is(body, 'foobar');
});

test('preserves body when redirect only adds an explicit default port', async t => {
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

	t.is(redirectedRequest.method, 'POST');
	t.is(redirectedRequest.body, 'foobar');
});

test('large body is preserved on 307 redirect', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 2, 'a');

	server.post('/redirect', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

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

		t.true(receivedBody.equals(requestBody));
		response.end('ok');
	});

	const {body} = await got.post('redirect', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	});

	t.is(body, 'ok');
});

test('injected request close before response emits pending request abort error', withServer, async (t, server, got) => {
	server.get('/pending-close', (_request, _response) => {
		// Keep request open until client-side close is injected below.
	});

	const pendingRequest = got('pending-close').on('request', clientRequest => {
		// Simulate the pre-response close edge case directly on the request object.
		clientRequest.emit('close');
	});

	const error = await t.throwsAsync<RequestError>(pendingRequest, {
		instanceOf: RequestError,
		message: 'The server aborted pending request',
	});

	t.is(error?.code, 'ECONNRESET');
});

test('method rewriting', withServer, async (t, server, got) => {
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
					t.is(options.body, undefined);
				},
			],
		},
	});

	t.is(body, '');

	const {body: permanentRedirectBody} = await got.post('permanentRedirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.method, 'GET');
					t.is(options.body, undefined);
				},
			],
		},
	});

	t.is(permanentRedirectBody, '');

	// Do not rewrite method on 307 or 308
	const {body: temporaryRedirectBody} = await got.post('temporaryRedirect', {
		body: 'foobar',
		methodRewriting: true,
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.body, 'foobar');
				},
			],
		},
	});

	t.is(temporaryRedirectBody, 'foobar');
});

test('upload progress total is reset on redirected GET request', withServer, async (t, server, got) => {
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

	t.is(body, 'ok');
	t.deepEqual(requestMethods, ['POST', 'GET']);

	const zeroTransferredEvents = events.filter(event => event.transferred === 0);
	t.true(zeroTransferredEvents.length >= 2);

	const redirectedRequestEvent = zeroTransferredEvents.at(-1);
	t.truthy(redirectedRequestEvent);
	t.is(redirectedRequestEvent?.total, undefined);
});

test('clears username and password when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(headers.authorization, undefined);
	});
});

test('clears the authorization header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(headers.authorization, undefined);
	});
});

test('clears the proxy-authorization header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(headers['proxy-authorization'], undefined);
	});
});

test('clears the cookie2 header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(headers.cookie2, undefined);
	});
});

test('clears credentials and sensitive headers when redirecting to a different protocol on the same hostname', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer.exec(t, async (t, serverHttp) => {
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

		t.is(headers.authorization, undefined);
		t.is(headers.cookie, undefined);
	});
});

test('does not forward body when redirecting to a different protocol on the same hostname', withHttpsServer(), async (t, serverHttps, got) => {
	await withServer.exec(t, async (t, serverHttp) => {
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
						t.is(options.method, 'GET');
						t.is(options.body, undefined);
					},
				],
			},
		}).json<{method: string; body: string; headers: Record<string, string | undefined>}>();

		t.is(redirectedRequest.method, 'GET');
		t.is(redirectedRequest.body, '');
		t.is(redirectedRequest.headers['content-type'], undefined);
	});
});

test('preserves userinfo on redirect to the same origin', withServer, async (t, server) => {
	server.get('/redirect', (_request, response) => {
		response.writeHead(303, {
			location: `http://localhost:${server.port}/`,
		});
		response.end();
	});

	server.get('/', (request, response) => {
		t.is(request.headers.authorization, 'Basic aGVsbG86d29ybGQ=');
		response.end();
	});

	await got(`http://hello:world@localhost:${server.port}/redirect`);
});

test('strips credentials embedded in cross-origin redirect Location URL', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(body.authorization, undefined);
	});
});

test('strips credentials embedded in cross-origin redirect Location URL on 307', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(body.authorization, undefined);
	});
});

test('strips both user-supplied and Location-embedded credentials on cross-origin redirect', withServer, async (t, server1) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(body.authorization, undefined);
	});
});

test('clears the host header when redirecting to a different hostname', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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
		t.is(resp.body, `localhost:${server2.port}`);
	});
});

test('correct port on redirect', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (t, server2) => {
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

		t.is(response.body, 'SERVER2');
	});
});

test('downloadProgress does not fire for redirect responses', withServer, async (t, server, got) => {
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
	t.true(progressEvents.length >= 2);

	// First event should be initial progress for final response
	t.is(progressEvents[0]?.transferred, 0);
	t.is(progressEvents[0]?.total, 1024);

	// Last event should be completion
	const lastEvent = progressEvents.at(-1)!;
	t.is(lastEvent.transferred, 1024);
	t.is(lastEvent.total, 1024);

	// All events should have total = 1024 (the final response size, not 0 from redirect)
	for (const event of progressEvents) {
		t.is(event.total, 1024);
	}
});

test('strips sensitive headers when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(headers.authorization, undefined);
		t.is(headers.cookie, undefined);
		t.is(headers.cookie2, undefined);
		t.is(headers['proxy-authorization'], undefined);
	});
});

test('preserves replacement authorization header when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(headers.authorization, 'Bearer replacement-secret');
	});
});

test('preserves explicitly reapplied authorization header when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(headers.authorization, 'Bearer same-secret');
	});
});

test('strips sensitive headers when beforeRedirect hook reassigns headers object without reapplying them', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(headers.authorization, undefined);
		t.is(headers.cookie, undefined);
		t.is(headers.foo, 'bar');
	});
});

test('preserves headers when beforeRedirect hook keeps the same origin', withServer, async (t, server, got) => {
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

	t.is(headers.authorization, 'Bearer keep-me');
});

test('preserves replacement credentials when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(headers.authorization, 'Basic bmV3LXVzZXI6bmV3LXBhc3N3b3Jk');
	});
});

test('preserves replacement credentials from options.username and options.password when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(headers.authorization, 'Basic bmV3LXVzZXI6bmV3LXBhc3N3b3Jk');
	});
});

test('strips sensitive headers when beforeRedirect hook mutates the existing URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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
			body: 'secret body',
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

		t.is(result.headers.authorization, undefined);
		t.is(result.headers.cookie, undefined);
		t.is(result.headers['content-type'], undefined);
		t.is(result.body, '');
	});
});

test('strips body when beforeRedirect hook changes URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
		server1.post('/', (_request, response) => {
			// 307 preserves method and body for same-origin
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
			hooks: {
				beforeRedirect: [
					options => {
						options.url = new URL(`http://localhost:${server2.port}/`);
					},
				],
			},
		}).json<{method: string; headers: Record<string, string | undefined>; body: string}>();

		t.is(result.method, 'POST');
		t.is(result.body, '');
		t.is(result.headers['content-type'], undefined);
	});
});

test('preserves replacement body when beforeRedirect hook changes URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.method, 'POST');
		t.is(result.body, 'new-data');
		t.is(result.headers['content-type'], 'text/plain');
	});
});

test('preserves replacement body when beforeRedirect hook mutates the existing URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.method, 'POST');
		t.is(result.body, 'new-data');
		t.is(result.headers['content-type'], 'text/plain');
	});
});

test('preserves explicitly reassigned same body when beforeRedirect hook mutates the existing URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.method, 'POST');
		t.is(result.body, 'same-data');
		t.is(result.headers['content-type'], 'text/plain');
	});
});

test('preserves in-place body rewrite when beforeRedirect hook mutates the existing URL to a different origin on 307', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.method, 'POST');
		t.is(result.body, 'new-data');
		t.is(result.headers['content-type'], 'text/plain');
	});
});

test('preserves replacement URL credentials when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.headers.authorization, `Basic ${Buffer.from('evil:hacker').toString('base64')}`);
	});
});

test('preserves explicit URL object credentials when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.headers.authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
	});
});

test('preserves explicit URL object username when beforeRedirect hook changes URL to a different origin', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.headers.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);
	});
});

test('strips inherited password when explicit URL object keeps only username during beforeRedirect cross-origin change', withServer, async (t, server1, got) => {
	await withServer.exec(t, async (_t, server2) => {
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

		t.is(result.headers.authorization, `Basic ${Buffer.from('user:').toString('base64')}`);
	});
});
