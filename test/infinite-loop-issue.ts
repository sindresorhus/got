import test from 'ava';
import withServer from './helpers/with-server.js';

// Test for issue #2414: Endless recurrent loop upon retry in options.js
// https://github.com/sindresorhus/got/issues/2414
test('does not cause infinite loop when retrying with request.options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 401;
		response.end();
	});

	let isCalled = false;

	await got({
		hooks: {
			afterResponse: [
				(response, retry) => {
					if (!isCalled) {
						isCalled = true;
						// This used to cause an infinite loop in versions 12-14
						return retry(response.request.options);
					}

					return response;
				},
			],
		},
		throwHttpErrors: false,
		retry: {
			limit: 0,
		},
	});

	t.true(isCalled);
});
