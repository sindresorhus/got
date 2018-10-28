import test from 'ava';
import delay from 'delay';
import {createServer} from './helpers/server';
import got from '..';

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
	const response = await got(s.url, {
		json: true,
		hooks: {
			beforeRequest: [
				async options => {
					await delay(100);
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(response.body.foo, 'bar');
});

test('catches thrown errors', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			beforeRequest: [
				() => {
					throw error;
				}
			]
		}
	}), errorString);
});

test('catches promise rejections', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			beforeRequest: [
				() => Promise.reject(error)
			]
		}
	}), errorString);
});

test('catches beforeRequest errors', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			beforeRequest: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeRedirect errors', async t => {
	await t.throwsAsync(() => got(`${s.url}/redirect`, {
		hooks: {
			beforeRedirect: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches beforeRetry errors', async t => {
	await t.throwsAsync(() => got(`${s.url}/retry`, {
		hooks: {
			beforeRetry: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('catches afterResponse errors', async t => {
	await t.throwsAsync(() => got(s.url, {
		hooks: {
			afterResponse: [() => Promise.reject(error)]
		}
	}), errorString);
});

test('beforeRequest', async t => {
	await got(s.url, {
		json: true,
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
	const response = await got(s.url, {
		json: true,
		hooks: {
			beforeRequest: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(response.body.foo, 'bar');
});

test('beforeRedirect', async t => {
	await got(`${s.url}/redirect`, {
		json: true,
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
	const response = await got(`${s.url}/redirect`, {
		json: true,
		hooks: {
			beforeRedirect: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(response.body.foo, 'bar');
});

test('beforeRetry', async t => {
	await got(`${s.url}/retry`, {
		json: true,
		retry: 1,
		throwHttpErrors: false,
		hooks: {
			beforeRetry: [
				options => {
					t.is(options.hostname, 'localhost');
				}
			]
		}
	});
});

test('beforeRetry allows modifications', async t => {
	const response = await got(`${s.url}/retry`, {
		json: true,
		hooks: {
			beforeRetry: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(response.body.foo, 'bar');
});

test('afterResponse', async t => {
	await got(`${s.url}`, {
		json: true,
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
	const response = await got(`${s.url}`, {
		json: true,
		hooks: {
			afterResponse: [
				response => {
					response.body = '{"hello": "world"}';

					return response;
				}
			]
		}
	});
	t.is(response.body.hello, 'world');
});

test('afterResponse allows to retry', async t => {
	const response = await got(`${s.url}/401`, {
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
	t.is(response.statusCode, 200);
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

	const response = await got(`${s.url}/401then500`, {
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
	t.is(response.statusCode, 500);
});
