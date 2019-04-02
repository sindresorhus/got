import test from 'ava';
import delay from 'delay';
import got from '../source';
import withServer from './helpers/with-server';

const errorString = 'oops';
const error = new Error(errorString);

const echoHeaders = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

const retryEndpoint = (request, response) => {
	if (request.headers.foo) {
		response.statusCode = 302;
		response.setHeader('location', '/');
		response.end();
	}

	response.statusCode = 500;
	response.end();
};

const redirectEndpoint = (_request, response) => {
	response.statusCode = 302;
	response.setHeader('location', '/');
	response.end();
};

test('async hooks', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				async options => {
					await delay(100);
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('catches init thrown errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches beforeRequest thrown errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			beforeRequest: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches beforeRedirect thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	await t.throwsAsync(got('redirect', {
		hooks: {
			beforeRedirect: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches beforeRetry thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	await t.throwsAsync(got('retry', {
		hooks: {
			beforeRetry: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches afterResponse thrown errors', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('throws a helpful error when passing async function as init hook', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			init: [() => Promise.resolve()]
		}
	}), 'The `init` hook must be a synchronous function');
});

test('catches beforeRequest promise rejections', async t => {
	await t.throwsAsync(got('https://example.com', {
		hooks: {
			beforeRequest: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeRedirect promise rejections', withServer, async (t, server, got) => {
	server.get('/', redirectEndpoint);

	await t.throwsAsync(got({
		hooks: {
			beforeRedirect: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeRetry promise rejections', withServer, async (t, server, got) => {
	server.get('/retry', retryEndpoint);

	await t.throwsAsync(got('retry', {
		hooks: {
			beforeRetry: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches afterResponse promise rejections', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await t.throwsAsync(got({
		hooks: {
			afterResponse: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeError errors', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {},
		hooks: {
			beforeError: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('init is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		hooks: {
			init: [
				options => {
					t.is(options.path, '/');
					t.is(options.hostname, 'localhost');
				}
			]
		}
	});
});

test('init allows modifications', withServer, async (t, server, got) => {
	server.get('/', async (request, response) => {
		response.end(request.headers.foo);
	});

	const {body} = await got({
		hooks: {
			init: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(body, 'bar');
});

test('beforeRequest is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.path, '/');
					t.is(options.hostname, 'localhost');
				}
			]
		}
	});
});

test('beforeRequest allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got({
		responseType: 'json',
		hooks: {
			beforeRequest: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('beforeRedirect is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	await got('redirect', {
		responseType: 'json',
		hooks: {
			beforeRedirect: [
				options => {
					t.is(options.path, '/');
					t.is(options.hostname, 'localhost');
				}
			]
		}
	});
});

test('beforeRedirect allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/redirect', redirectEndpoint);

	const {body} = await got('redirect', {
		responseType: 'json',
		hooks: {
			beforeRedirect: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('beforeRetry is called with options', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	await got('retry', {
		responseType: 'json',
		retry: 1,
		throwHttpErrors: false,
		hooks: {
			beforeRetry: [
				(options, error, retryCount) => {
					t.is(options.hostname, 'localhost');
					t.truthy(error);
					t.true(retryCount >= 1);
				}
			]
		}
	});
});

test('beforeRetry allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);
	server.get('/retry', retryEndpoint);

	const {body} = await got('retry', {
		responseType: 'json',
		hooks: {
			beforeRetry: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(body.foo, 'bar');
});

test('afterResponse is called with response', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	await got({
		responseType: 'json',
		hooks: {
			afterResponse: [
				response => {
					t.is(typeof response.body, 'string');

					return response;
				}
			]
		}
	});
});

test('afterResponse allows modifications', withServer, async (t, server, got) => {
	server.get('/', echoHeaders);

	const {body} = await got({
		responseType: 'json',
		hooks: {
			afterResponse: [
				response => {
					response.body = '{"hello": "world"}';

					return response;
				}
			]
		}
	});
	t.is(body.hello, 'world');
});

test('afterResponse allows to retry', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	const {statusCode} = await got({
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			]
		}
	});
	t.is(statusCode, 200);
});

test('no infinity loop when retrying on afterResponse', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	await t.throwsAsync(got({
		retry: 0,
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => {
					return retryWithMergedOptions({
						headers: {
							token: 'invalid'
						}
					});
				}
			]
		}
	}), {instanceOf: got.HTTPError, message: 'Response code 401 (Unauthorized)'});
});

test('throws on afterResponse retry failure', withServer, async (t, server, got) => {
	let visited401then500;
	server.get('/', (_request, response) => {
		if (visited401then500) {
			response.statusCode = 500;
		} else {
			visited401then500 = true;
			response.statusCode = 401;
		}

		response.end();
	});

	await t.throwsAsync(got({
		retry: 1,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			]
		}
	}), {instanceOf: got.HTTPError, message: 'Response code 500 (Internal Server Error)'});
});

test('doesn\'t throw on afterResponse retry HTTP failure if throwHttpErrors is false', withServer, async (t, server, got) => {
	let visited401then500;
	server.get('/', (_request, response) => {
		if (visited401then500) {
			response.statusCode = 500;
		} else {
			visited401then500 = true;
			response.statusCode = 401;
		}

		response.end();
	});

	const {statusCode} = await got({
		throwHttpErrors: false,
		retry: 1,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 401) {
						return retryWithMergedOptions({
							headers: {
								token: 'unicorn'
							}
						});
					}

					return response;
				}
			]
		}
	});
	t.is(statusCode, 500);
});

test('beforeError is called with an error', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw error;
		},
		hooks: {
			beforeError: [error2 => {
				t.true(error2 instanceof Error);
				return error2;
			}]
		}
	}), errorString);
});

test('beforeError allows modifications', async t => {
	const errorString2 = 'foobar';

	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw error;
		},
		hooks: {
			beforeError: [() => {
				return new Error(errorString2);
			}]
		}
	}), errorString2);
});
