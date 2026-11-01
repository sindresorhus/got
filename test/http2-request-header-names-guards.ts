import assert from 'node:assert/strict';
import test from './helpers/test.js';
import {withHttpsServer} from './helpers/with-server.js';

test('HTTP/1 fallback keeps the native raw header casing', withHttpsServer(), async (_t, server, got) => {
	server.get('/', (request, response) => {
		response.json(request.rawHeaders.filter((_value, index) => index % 2 === 0));
	});
	let notifications = 0;
	const names = await got('', {
		http2: true,
		agent: {https: false},
	}).on('request', request => {
		notifications++;
		request.setHeader('X-Mixed-Case', 'sent');
		assert.ok(request.getRawHeaderNames().includes('X-Mixed-Case'));
		assert.ok(request.getHeaderNames().includes('x-mixed-case'));
	}).json<string[]>();
	assert.ok(names.includes('X-Mixed-Case'));
	assert.strictEqual(notifications, 1);
});
