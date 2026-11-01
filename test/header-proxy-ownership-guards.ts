import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {Options} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('a replaced header proxy remains a mutable detached object', _t => {
	const options = new Options({headers: {'x-previous': 'initial'}});
	const previousHeaders = options.headers;
	options.headers = {'x-current': 'current'};

	previousHeaders['X-Previous'] = 'changed';
	assert.strictEqual(previousHeaders['x-previous'], 'changed');
	delete previousHeaders['X-Previous'];
	assert.strictEqual(previousHeaders['x-previous'], undefined);
	assert.deepStrictEqual({...options.headers}, {'x-current': 'current'});
});

for (const operation of ['assignment', 'deletion'] as const) {
	test(`a retained header proxy still controls authorization after a merge through ${operation}`, withServer, async (_t, server, got) => {
		server.get('/', (request, response) => {
			response.end(request.headers.authorization ?? '');
		});
		const response = await got('', {
			username: 'client',
			password: 'secret',
			hooks: {
				beforeRequest: [options => {
					const {headers} = options;
					options.merge({headers: {'x-added': 'merged'}});
					if (operation === 'assignment') {
						headers.authorization = undefined;
					} else {
						delete headers.authorization;
					}
				}],
			},
		});
		assert.strictEqual(response.body, operation === 'assignment' ? '' : `Basic ${Buffer.from('client:secret').toString('base64')}`);
	});
}
