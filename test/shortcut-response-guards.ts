import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

test('chained shortcuts retain a handler replacement response and its parsing options', withServer, async (_t, server, got) => {
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
		handlers: [async (options, next) => {
			await next(options);
			return replacement as Awaited<ReturnType<typeof next>>;
		}],
	});
	const pending = client('original');
	assert.strictEqual(await pending, replacement);
	const json = pending.json<{source: string; parsedBy: string}>();
	assert.deepStrictEqual(await json, {source: 'replacement', parsedBy: 'replacement'});
	assert.strictEqual(await json.text(), '{"source":"replacement"}');
	assert.deepStrictEqual(await json.buffer(), replacement.rawBody);
	assert.deepStrictEqual(await json.text().json(), {source: 'replacement', parsedBy: 'replacement'});
});

test('concurrent and chained shortcuts stay on the final retry response', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.status(requests === 1 ? 503 : 200).json({attempt: requests});
	});
	const pending = got('', {retry: {limit: 1, backoffLimit: 0, noise: 0}});
	const [response, json, text, bytes] = await Promise.all([pending, pending.json(), pending.text(), pending.buffer()]);
	assert.strictEqual(requests, 2);
	assert.strictEqual(response.retryCount, 1);
	assert.deepStrictEqual(json, {attempt: 2});
	assert.strictEqual(text, '{"attempt":2}');
	assert.deepStrictEqual(bytes, response.rawBody);
	assert.deepStrictEqual(await pending.text().json(), {attempt: 2});
	assert.strictEqual(await pending.buffer().text(), text);
	assert.strictEqual(requests, 2);
});

test('repeated shortcuts read the current bytes of a handler replacement response', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.json({value: 1});
	});
	const replacement = await got('');
	const client = got.extend({
		handlers: [async (options, next) => {
			await next(options);
			return replacement as Awaited<ReturnType<typeof next>>;
		}],
	});
	const pending = client('');
	assert.deepStrictEqual(await pending.json(), {value: 1});
	replacement.rawBody = new TextEncoder().encode('{"value":2}');
	assert.deepStrictEqual(await pending.text().json(), {value: 2});
	assert.strictEqual(await pending.text(), '{"value":2}');
});
