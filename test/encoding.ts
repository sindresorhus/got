import {Buffer} from 'node:buffer';
import assert from 'node:assert/strict';
import type {HTTPError} from '../source/index.js';
import test from './helpers/test.js';
import {rejects} from './helpers/rejects.js';
import withServer from './helpers/with-server.js';

test('encoding works with json', withServer, async (_t, server, got) => {
	const json = {data: 'é'};

	server.get('/', (_request, response) => {
		response.set('Content-Type', 'application-json');
		response.send(Buffer.from(JSON.stringify(json), 'latin1'));
	});

	const response = await got('', {
		encoding: 'latin1',
		responseType: 'json',
	});

	assert.deepStrictEqual(response.body, json);
});

test('encoding works with text', withServer, async (_t, server, got) => {
	const text = 'café';

	server.get('/', (_request, response) => {
		response.send(Buffer.from(text, 'latin1'));
	});

	const response = await got('', {
		encoding: 'latin1',
		responseType: 'text',
	});

	assert.strictEqual(response.body, text);
});

const latin1Text = 'café';
const latin1Bytes = Buffer.from(latin1Text, 'latin1');

test('`responseType: buffer` ignores the encoding', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(latin1Bytes);
	});

	const response = await got('', {encoding: 'base64', responseType: 'buffer'});

	assert.deepStrictEqual(response.body, new Uint8Array(latin1Bytes));
	assert.strictEqual(response.body, response.rawBody);
});

test('the `.buffer()` shortcut ignores the encoding while `.text()` honors it', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(latin1Bytes);
	});

	const promise = got('', {encoding: 'latin1'});
	const [buffer, text] = await Promise.all([promise.buffer(), promise.text()]);

	assert.deepStrictEqual(buffer, new Uint8Array(latin1Bytes));
	assert.strictEqual(text, latin1Text);
});

test('the `hex` encoding decodes the text body as hexadecimal', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from([0xEF, 0xBB, 0xBF, 0x00, 0xFF]));
	});

	// A UTF-8 byte order mark is only stripped when decoding text as UTF-8.
	assert.strictEqual((await got('', {encoding: 'hex'})).body, 'efbbbf00ff');
});

test('HTTP error bodies are decoded with the encoding', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end(latin1Bytes);
	});

	const error = await rejects<HTTPError>(got('', {encoding: 'latin1', retry: {limit: 0}}), {name: 'HTTPError'});

	assert.strictEqual(error.response.body, latin1Text);
});

test('`parseJson` receives the text decoded with the encoding', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end(Buffer.from(JSON.stringify({value: latin1Text}), 'latin1'));
	});

	const received: string[] = [];
	const body = await got('', {
		encoding: 'latin1',
		parseJson(text) {
			received.push(text);
			return JSON.parse(text);
		},
	}).json();

	assert.deepStrictEqual(received, [JSON.stringify({value: latin1Text})]);
	assert.deepStrictEqual(body, {value: latin1Text});
});

for (const encoding of ['ucs2', 'ucs-2', 'UTF-16LE']) {
	test(`the \`${encoding}\` alias strips a UTF-16LE byte order mark like \`utf16le\``, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end(Buffer.from('\u{FEFF}{"value":"café"}', 'utf16le'));
		});

		const promise = got('', {encoding: encoding as BufferEncoding});
		const [text, json] = await Promise.all([promise.text(), promise.json()]);

		assert.strictEqual(text, '{"value":"café"}');
		assert.deepStrictEqual(json, {value: 'café'});
	});
}
