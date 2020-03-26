import test from 'ava';

import withServer from './helpers/with-server';

test.failing('handler not work as expected when using text method', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});
	const custom = got.extend({
		handlers: [
			function (options, next) {
				if (options.isStream || options.responseType !== 'text') {
					// It's a Stream or it is not return text
					return next(options);
				}

				return (async () => {
					try {
						const response = await next(options);
						// When the responseType is text and it is not a stream, repeat the response body twice
						// @ts-ignore
						response.body = response.body.repeat(2);
						return await response;
					} catch (error) {
						throw new Error(`Error in handlers ${error.message as string}`);
					}
				})();
			}
		]
	});
	const response = await custom('');
	t.is(response.body, 'okok');
	const r = custom('');
	const text = await r.text();
	t.is(text, 'okok');
});
