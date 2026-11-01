import assert from 'node:assert/strict';
import got, {Options} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('extend retains an Options instance constructor configuration', withServer, async (_t, server) => {
	server.get('/base/resource', (request, response) => {
		response.json({header: request.headers['x-options'], hook: request.headers['x-hook']});
	});
	const options = new Options({
		prefixUrl: `${server.url}/base/`,
		headers: {'x-options': 'configured'},
		hooks: {
			beforeRequest: [options => {
				options.headers['x-hook'] = 'ran';
			}],
		},
	});
	assert.deepStrictEqual(await got.extend(options)('resource').json(), {header: 'configured', hook: 'ran'});
});

test('extend replays an Options instance merge configuration', withServer, async (_t, server) => {
	server.get('/', (request, response) => {
		response.end(request.headers.foo);
	});
	const options = new Options({prefixUrl: server.url, headers: {foo: 'foo'}});
	options.merge({headers: {foo: 'bar'}});
	assert.strictEqual(await got.extend(options)('').text(), 'bar');
});

test('an Options instance preserves earlier response defaults when extended', withServer, async (_t, server) => {
	server.get('/', (request, response) => {
		response.json({parent: request.headers['x-parent'], child: request.headers['x-child']});
	});
	const parent = got.extend({
		prefixUrl: server.url,
		responseType: 'json',
		resolveBodyOnly: true,
		headers: {'x-parent': 'kept'},
	});
	const options = new Options({headers: {'x-child': 'merged'}});
	assert.deepStrictEqual(await parent.extend(options)(''), {parent: 'kept', child: 'merged'});
});

test('an Options instance does not merge its constructor URL', withServer, async (_t, server) => {
	server.get('/', (request, response) => {
		response.end(request.headers['x-options']);
	});
	const options = new Options('https://unused.example', {headers: {'x-options': 'kept'}});
	const client = got.extend({prefixUrl: server.url}, options);
	assert.strictEqual(await client('').text(), 'kept');
});
