import test from 'ava';
import delay from 'delay';
import getStream from 'get-stream';
import got from '../source';
import {createServer} from './helpers/server';

const errorString = 'oops';
const error = new Error(errorString);
let s;

let visited401then500;

test.before('setup', async () => {
	s = await createServer();
	const echoHeaders = (request, response) => {
		response.statusCode = 200;
		response.write(JSON.stringify(request.headers));
		response.end();
	};

	s.on('/', echoHeaders);
	s.on('/body', async (request, response) => {
		response.end(await getStream(request));
	});
	s.on('/redirect', (request, response) => {
		response.statusCode = 302;
		response.setHeader('location', '/');
		response.end();
	});
	s.on('/retry', (request, response) => {
		if (request.headers.foo) {
			response.statusCode = 302;
			response.setHeader('location', '/');
			response.end();
		}

		response.statusCode = 500;
		response.end();
	});

	s.on('/401', (request, response) => {
		if (request.headers.token !== 'unicorn') {
			response.statusCode = 401;
		}

		response.end();
	});

	s.on('/401then500', (request, response) => {
		if (visited401then500) {
			response.statusCode = 500;
		} else {
			visited401then500 = true;
			response.statusCode = 401;
		}

		response.end();
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('async hooks', async t => {
	const {body} = await got(s.url, {
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
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			init: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches beforeRequest thrown errors', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			beforeRequest: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches beforeRedirect thrown errors', async t => {
	await t.throwsAsync(() => got(`${s.url}/redirect`, {
		hooks: {
			beforeRedirect: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches beforeRetry thrown errors', async t => {
	await t.throwsAsync(() => got(`${s.url}/retry`, {
		hooks: {
			beforeRetry: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('catches afterResponse thrown errors', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			afterResponse: [() => {
				throw error;
			}]
		}
	}), errorString);
});

test('throws a helpful error when passing async function as init hook', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			init: [() => Promise.resolve()]
		}
	}), 'The `init` hook must be a synchronous function');
});

test('catches beforeRequest promise rejections', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			beforeRequest: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeRedirect promise rejections', async t => {
	await t.throwsAsync(() => got(`${s.url}/redirect`, {
		hooks: {
			beforeRedirect: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeRetry promise rejections', async t => {
	await t.throwsAsync(() => got(`${s.url}/retry`, {
		hooks: {
			beforeRetry: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches afterResponse promise rejections', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			afterResponse: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeError errors', async t => {
	await t.throwsAsync(() => got(s.url, {
		request: () => {},
		hooks: {
			beforeError: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('init is called with options', async t => {
	await got(s.url, {
		json: true,
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

test('init allows modifications', async t => {
	const {body} = await got(`${s.url}/body`, {
		hooks: {
			init: [
				options => {
					options.body = 'foobar';
				}
			]
		}
	});
	t.is(body, 'foobar');
});

test('beforeRequest is called with options', async t => {
	await got(s.url, {
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

test('beforeRequest allows modifications', async t => {
	const {body} = await got(s.url, {
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

test('beforeRedirect is called with options', async t => {
	await got(`${s.url}/redirect`, {
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

test('beforeRedirect allows modifications', async t => {
	const {body} = await got(`${s.url}/redirect`, {
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

test('beforeRetry is called with options', async t => {
	await got(`${s.url}/retry`, {
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

test('beforeRetry allows modifications', async t => {
	const {body} = await got(`${s.url}/retry`, {
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

test('afterResponse is called with response', async t => {
	await got(`${s.url}`, {
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

test('afterResponse allows modifications', async t => {
	const {body} = await got(`${s.url}`, {
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

test('afterResponse allows to retry', async t => {
	const {statusCode} = await got(`${s.url}/401`, {
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

test('no infinity loop when retrying on afterResponse', async t => {
	await t.throwsAsync(got(`${s.url}/401`, {
		retry: 0,
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
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

test.serial('throws on afterResponse retry failure', async t => {
	visited401then500 = false;

	await t.throwsAsync(got(`${s.url}/401then500`, {
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

test.serial('doesn\'t throw on afterResponse retry HTTP failure if throwHttpErrors is false', async t => {
	visited401then500 = false;

	const {statusCode} = await got(`${s.url}/401then500`, {
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
	await t.throwsAsync(() => got(s.url, {
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

	await t.throwsAsync(() => got(s.url, {
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
