import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import {createCrossOriginReceiver} from './helpers/server-tools.js';

test('checking an unchanged upload view reuses its owned snapshot without copying the current bytes', withServer, async (t, _server, got) => {
	const {server: receiver, received} = await createCrossOriginReceiver();
	t.after(receiver.close);
	const body = Buffer.alloc(128 * 1024, 'a');
	const copy = t.mock.method(Uint8Array.prototype, 'slice');
	const clone = t.mock.method(globalThis, 'structuredClone');
	await got.post('', {
		body,
		hooks: {
			beforeRequest: [options => {
				options.url = new URL(`${receiver.url}/steal`);
			}],
		},
	});
	const bodyCopies = [
		...copy.mock.calls.filter(call => call.this instanceof Uint8Array && call.this.buffer === body.buffer && call.this.byteOffset === body.byteOffset && call.this.byteLength === body.byteLength).map(call => call.result),
		...clone.mock.calls.filter(call => call.arguments[0] === body).map(call => call.result as Uint8Array),
	];
	assert.strictEqual(received.body, '');
	assert.deepStrictEqual(bodyCopies.map(copy => copy?.byteLength), [body.byteLength]);
	assert.deepStrictEqual(body, Buffer.alloc(body.byteLength, 'a'));
});
