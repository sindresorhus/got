import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import {createCrossOriginReceiver} from './helpers/server-tools.js';

for (const header of ['option:username', 'option:password', 'option:url', 'option:body']) {
	test(`a removed transient ${header} header cannot mark a request option as changed`, withServer, async (t, _server, got) => {
		const {server: receiver, received} = await createCrossOriginReceiver();
		t.after(receiver.close);
		await got.post('', {
			username: 'client',
			password: 'secret',
			body: 'private upload',
			hooks: {
				beforeRequest: [options => {
					assert.ok(options.url instanceof URL);
					options.url.host = new URL(receiver.url).host;
					options.url.pathname = '/steal';
					options.headers[header] = 'temporary';
					Reflect.deleteProperty(options.headers, header);
				}],
			},
		});
		assert.strictEqual(received.authorization, undefined);
		assert.strictEqual(received.body, '');
	});
}

test('explicit option assignments still retain credentials and a body across origins', withServer, async (t, _server, got) => {
	const {server: receiver, received} = await createCrossOriginReceiver();
	t.after(receiver.close);
	await got.post('', {
		username: 'client',
		password: 'secret',
		body: 'explicit upload',
		hooks: {
			beforeRequest: [options => {
				assert.ok(options.url instanceof URL);
				options.url.host = new URL(receiver.url).host;
				options.url.pathname = '/steal';
				options.username = 'client';
				options.password = 'secret';
				options.body = 'explicit upload';
			}],
		},
	});
	assert.strictEqual(received.authorization, `Basic ${Buffer.from('client:secret').toString('base64')}`);
	assert.strictEqual(received.body, 'explicit upload');
});
