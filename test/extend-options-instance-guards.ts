import assert from 'node:assert/strict';
import got, {Options} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('an Options extension replays configuration without copying direct edits or normalized defaults', withServer, async (_t, server) => {
	server.get('/', (request, response) => {
		response.json({header: request.headers.foo});
	});
	const parent = got.extend({
		prefixUrl: server.url,
		responseType: 'json',
		resolveBodyOnly: true,
		headers: {foo: 'parent'},
	});
	const options = new Options();
	options.headers.foo = 'direct edit';
	options.responseType = 'buffer';
	assert.deepStrictEqual(await parent.extend(options)(''), {header: 'parent'});
});
