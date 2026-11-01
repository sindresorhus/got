import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {HTTPError} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('body shortcuts use the current response after a handler recovers a hook HTTP error body', withServer, async (_t, server, got) => {
	const text = '{"missing":true}';
	server.get('/', (_request, response) => {
		response.status(404).end(text);
	});
	const client = got.extend({
		resolveBodyOnly: true,
		retry: {limit: 0},
		hooks: {
			afterResponse: [response => {
				throw new HTTPError(response);
			}],
		},
		handlers: [async (options, next) => {
			try {
				return await next(options);
			} catch (error) {
				if (error instanceof HTTPError) {
					return error.response.body as Awaited<ReturnType<typeof next>>;
				}

				throw error;
			}
		}],
	});
	const pending = client('');
	assert.strictEqual(await pending, text);
	const [json, string, bytes] = await Promise.all([pending.json(), pending.text(), pending.buffer()]);
	assert.deepStrictEqual(json, {missing: true});
	assert.strictEqual(string, text);
	assert.deepStrictEqual(bytes, new Uint8Array(Buffer.from(text)));
	assert.strictEqual(await pending.json({
		'~standard': {
			version: 1,
			vendor: 'got-test',
			validate(value) {
				assert.deepStrictEqual(value, {missing: true});
				return {value: 'validated'};
			},
		},
	}), 'validated');
});

test('a recovered hook error retains the response returned by an earlier hook', withServer, async (_t, server, got) => {
	server.get('/original', (_request, response) => {
		response.json({source: 'original'});
	});
	server.get('/replacement', (_request, response) => {
		response.json({source: 'replacement'});
	});
	const replacement = await got('replacement', {
		parseJson(text) {
			return {...JSON.parse(text) as Record<string, unknown>, parsedBy: 'replacement'};
		},
	});
	const client = got.extend({
		resolveBodyOnly: true,
		retry: {limit: 0},
		hooks: {
			afterResponse: [() => replacement, response => {
				assert.strictEqual(response, replacement);
				throw new HTTPError(response);
			}],
		},
		handlers: [async (options, next) => {
			try {
				return await next(options);
			} catch (error) {
				if (error instanceof HTTPError) {
					return error.response.body as Awaited<ReturnType<typeof next>>;
				}

				throw error;
			}
		}],
	});
	const pending = client('original');
	assert.strictEqual(await pending, replacement.body);
	assert.deepStrictEqual(await pending.json(), {source: 'replacement', parsedBy: 'replacement'});
	assert.strictEqual(await pending.text(), replacement.body);
});
