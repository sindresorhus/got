import assert from 'node:assert/strict';
import type {Handler} from 'express';
import got, {type BeforeRequestHook, type Got, type Headers} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const echoHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.headers));
};

test('merging instances', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({prefixUrl: server.url});
	const merged = instanceA.extend(instanceB);

	const headers = await merged('').json<Headers>();
	assert.strictEqual(headers.unicorn, 'rainbow');
	assert.notStrictEqual(headers['user-agent'], undefined);
});

test('merges default handlers & custom handlers', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({
		handlers: [
			(options, next) => {
				options.headers.cat = 'meow';
				return next(options);
			},
		],
	});
	const merged = instanceA.extend(instanceB);

	const headers = await merged(server.url).json<Headers>();
	assert.strictEqual(headers.unicorn, 'rainbow');
	assert.strictEqual(headers.cat, 'meow');
});

test('merging one group & one instance', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const merged = instanceA.extend(instanceB, instanceC);
	const doubleMerged = merged.extend(instanceD);

	const headers = await doubleMerged(server.url).json<Headers>();
	assert.strictEqual(headers.dog, 'woof');
	assert.strictEqual(headers.cat, 'meow');
	assert.strictEqual(headers.bird, 'tweet');
	assert.strictEqual(headers.mouse, 'squeek');
});

test('merging two groups of merged instances', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const instanceA = got.extend({headers: {dog: 'woof'}});
	const instanceB = got.extend({headers: {cat: 'meow'}});
	const instanceC = got.extend({headers: {bird: 'tweet'}});
	const instanceD = got.extend({headers: {mouse: 'squeek'}});

	const groupA = instanceA.extend(instanceB);
	const groupB = instanceC.extend(instanceD);

	const merged = groupA.extend(groupB);

	const headers = await merged(server.url).json<Headers>();
	assert.strictEqual(headers.dog, 'woof');
	assert.strictEqual(headers.cat, 'meow');
	assert.strictEqual(headers.bird, 'tweet');
	assert.strictEqual(headers.mouse, 'squeek');
});

test('hooks are merged', _t => {
	const getBeforeRequestHooks = (instance: Got): BeforeRequestHook[] => instance.defaults.options.hooks.beforeRequest;

	const instanceA = got.extend({
		hooks: {
			beforeRequest: [
				options => {
					options.headers.dog = 'woof';
				},
			],
		},
	});
	const instanceB = got.extend({
		hooks: {
			beforeRequest: [
				options => {
					options.headers.cat = 'meow';
				},
			],
		},
	});

	const merged = instanceA.extend(instanceB);
	assert.deepStrictEqual(getBeforeRequestHooks(merged), [...getBeforeRequestHooks(instanceA), ...getBeforeRequestHooks(instanceB)]);
});

test('default handlers are not duplicated', _t => {
	const instance = got.extend(got);
	assert.strictEqual(instance.defaults.handlers.length, 0);
});

test('URL is not polluted', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	await got({
		username: 'foo',
	});

	const {options: normalizedOptions} = (await got({})).request;

	assert.strictEqual(normalizedOptions.username, '');
});

test('merging instances with HTTPS options', _t => {
	const instanceA = got.extend({
		https: {
			rejectUnauthorized: true,
			certificate: 'FIRST',
		},
	});
	const instanceB = got.extend({
		https: {
			certificate: 'SECOND',
		},
	});

	const merged = instanceA.extend(instanceB);

	assert.strictEqual(merged.defaults.options.https.rejectUnauthorized, true);
	assert.strictEqual(merged.defaults.options.https.certificate, 'SECOND');
});

test('merging instances with HTTPS options undefined', _t => {
	const instanceA = got.extend({
		https: {
			rejectUnauthorized: true,
			certificate: 'FIRST',
		},
	});
	const instanceB = got.extend({
		https: {
			certificate: undefined,
		},
	});

	const merged = instanceA.extend(instanceB);

	assert.strictEqual(merged.defaults.options.https.rejectUnauthorized, true);
	assert.strictEqual(merged.defaults.options.https.certificate, undefined);
});

test('accepts options for promise API', _t => {
	assert.doesNotThrow(() => {
		got.extend({
			hooks: {
				beforeRequest: [
					options => {
						options.responseType = 'buffer';
					},
				],
			},
		});
	});
});

test('merging `prefixUrl`', _t => {
	const prefixUrl = 'http://example.com/';

	const instanceA = got.extend({headers: {unicorn: 'rainbow'}});
	const instanceB = got.extend({prefixUrl});
	const mergedAonB = instanceB.extend(instanceA);
	const mergedBonA = instanceA.extend(instanceB);

	assert.strictEqual(mergedAonB.defaults.options.prefixUrl, prefixUrl);
	assert.strictEqual(mergedBonA.defaults.options.prefixUrl, prefixUrl);

	assert.strictEqual(instanceB.extend({}).defaults.options.prefixUrl, prefixUrl);
});

const echoRawHeaders: Handler = (request, response) => {
	response.end(JSON.stringify(request.rawHeaders));
};

const getHeaderValues = (rawHeaders: string[], name: string): string[] => rawHeaders.filter((_value, index) => index % 2 === 1 && rawHeaders[index - 1]!.toLowerCase() === name);

test('a later instance replaces a header of an earlier one whatever its case', withServer, async (_t, server) => {
	server.get('/', echoRawHeaders);

	const instanceA = got.extend({headers: {'X-Token': 'first'}});
	const instanceB = got.extend({headers: {'x-token': 'second'}});

	const forward = await instanceA.extend(instanceB)(server.url).json<string[]>();
	const backward = await instanceB.extend(instanceA)(server.url).json<string[]>();

	assert.deepStrictEqual(getHeaderValues(forward, 'x-token'), ['second']);
	assert.deepStrictEqual(getHeaderValues(backward, 'x-token'), ['first']);
});

test('got.extend applies instances and options in argument order', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const instance = got.extend({headers: {token: 'instance'}});

	const optionsLast = await got.extend(instance, {headers: {token: 'options'}})(server.url).json<Headers>();
	const instanceLast = await got.extend({headers: {token: 'options'}}, instance)(server.url).json<Headers>();

	assert.strictEqual(optionsLast.token, 'options');
	assert.strictEqual(instanceLast.token, 'instance');
});

test('handlers of merged instances wrap each other in merge order', withServer, async (_t, server) => {
	server.get('/', echoHeaders);

	const events: string[] = [];
	const createInstance = (name: string) => got.extend({
		handlers: [
			async (options, next) => {
				events.push(`${name} before`);
				const result = await next(options);
				events.push(`${name} after`);
				return result;
			},
		],
	});

	const instanceA = createInstance('a');
	const instanceB = createInstance('b');

	await instanceA.extend(instanceB)(server.url);
	assert.deepStrictEqual(events, ['a before', 'b before', 'b after', 'a after']);

	events.length = 0;
	await instanceB.extend(instanceA)(server.url);
	assert.deepStrictEqual(events, ['b before', 'a before', 'a after', 'b after']);
});

test('merging instances combines nested retry and timeout options member-wise', _t => {
	const instanceA = got.extend({
		retry: {
			limit: 5,
			methods: ['GET'],
		},
		timeout: {
			request: 1000,
		},
	});
	const instanceB = got.extend({
		retry: {
			limit: 1,
		},
		timeout: {
			connect: 500,
		},
	});

	const {retry, timeout} = instanceA.extend(instanceB).defaults.options;

	assert.strictEqual(retry.limit, 1);
	assert.deepStrictEqual(retry.methods, ['GET']);
	assert.strictEqual(timeout.request, 1000);
	assert.strictEqual(timeout.connect, 500);
});
