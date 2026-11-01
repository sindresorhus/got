import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const operation of ['assignment', 'deletion'] as const) {
	test(`a replaced header proxy cannot change current authorization intent through ${operation}`, withServer, async (_t, server, got) => {
		server.get('/', (request, response) => {
			response.end(request.headers.authorization ?? '');
		});
		const response = await got('', {
			username: 'client',
			password: 'secret',
			hooks: {
				beforeRequest: [options => {
					const previousHeaders = options.headers;
					options.headers = operation === 'assignment' ? {} : {authorization: undefined};
					if (operation === 'assignment') {
						previousHeaders.authorization = undefined;
					} else {
						delete previousHeaders.authorization;
					}
				}],
			},
		});
		assert.strictEqual(response.body, operation === 'assignment' ? `Basic ${Buffer.from('client:secret').toString('base64')}` : '');
	});
}
