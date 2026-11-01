import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {Options, isBodyUnchanged, snapshotCrossOriginState} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import {createCrossOriginReceiver} from './helpers/server-tools.js';

for (const [name, makeView] of [
	['Uint8ClampedArray', (buffer: ArrayBuffer) => new Uint8ClampedArray(buffer, 8, 8)],
	['BigInt64Array', (buffer: ArrayBuffer) => new BigInt64Array(buffer, 8, 1)],
] as const) {
	for (const mutation of ['unchanged', 'changed', 'restored'] as const) {
		test(`cross-origin ${name} comparison preserves ${mutation} byte semantics`, withServer, async (t, _server, got) => {
			const {server: receiver, received} = await createCrossOriginReceiver();
			t.after(receiver.close);
			const buffer = new ArrayBuffer(32);
			const bytes = new Uint8Array(buffer, 8, 8);
			bytes.set(Buffer.from('private!'));
			const body = makeView(buffer);
			await got.post('', {
				body,
				hooks: {
					beforeRequest: [options => {
						options.url = new URL(`${receiver.url}/steal`);
						if (mutation !== 'unchanged') {
							bytes.set(Buffer.from('public!!'));
						}

						if (mutation === 'restored') {
							bytes.set(Buffer.from('private!'));
						}
					}],
				},
			});
			assert.strictEqual(received.body, mutation === 'changed' ? 'public!!' : '');
			assert.strictEqual(body.buffer, buffer);
			assert.strictEqual(body.byteOffset, 8);
			assert.strictEqual(body.byteLength, 8);
		});
	}
}

for (const [name, makeView] of [
	['Uint8Array', (buffer: ArrayBuffer) => new Uint8Array(buffer)],
	['DataView', (buffer: ArrayBuffer) => new DataView(buffer)],
] as const) {
	test(`a detached ${name} comparison returns changed instead of throwing`, _t => {
		const buffer = new ArrayBuffer(16);
		const body = makeView(buffer);
		const options = new Options('https://example.com/', {method: 'POST', body});
		const snapshot = snapshotCrossOriginState(options);
		structuredClone(buffer, {transfer: [buffer]});
		assert.strictEqual(isBodyUnchanged(options, snapshot), false);
	});
}
