import {Agent} from 'node:http';
import {Buffer} from 'node:buffer';
import assert from 'node:assert/strict';
import {expectTypeOf} from 'expect-type';
import ResponseLike from 'responselike';
import got, {Options, type NormalizedOptions} from '../source/index.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';

test('cloned options own their TLS protocol arrays', _t => {
	const original = new Options({https: {alpnProtocols: ['h2', 'http/1.1']}});
	const clone = new Options(undefined, undefined, original);
	clone.https.alpnProtocols!.shift();

	assert.deepStrictEqual(original.https.alpnProtocols, ['h2', 'http/1.1']);
	assert.deepStrictEqual(clone.https.alpnProtocols, ['http/1.1']);
});

test('immutable defaults protect TLS protocol arrays without freezing caller input', _t => {
	const protocols = ['h2', 'http/1.1'];
	const client = got.extend({https: {alpnProtocols: protocols}});

	assert.throws(() => {
		client.defaults.options.https.alpnProtocols!.push('custom');
	}, TypeError);
	protocols.push('custom');
	assert.deepStrictEqual(client.defaults.options.https.alpnProtocols, ['h2', 'http/1.1']);
});

for (const property of ['certificateAuthority', 'certificate', 'certificateRevocationLists', 'alpnProtocols'] as const) {
	test(`TLS ${property} lists are isolated through assignment, merging, and cloning`, _t => {
		const values = ['first'];
		const options = new Options({https: {[property]: values}});
		values.push('caller');
		assert.deepStrictEqual(options.https[property], ['first']);

		const assigned = ['assigned'];
		options.https = {[property]: assigned};
		assigned.push('caller');
		assert.deepStrictEqual(options.https[property], ['assigned']);

		const merged = ['merged'];
		options.merge({https: {[property]: merged}});
		merged.push('caller');
		const clone = new Options(undefined, undefined, options);
		(clone.https[property] as string[]).push('clone');
		assert.deepStrictEqual(options.https[property], ['merged']);
		assert.deepStrictEqual(clone.https[property], ['merged', 'clone']);
	});
}

test('TLS key and PFX descriptors are isolated while preserving binary data', _t => {
	const bytes = Buffer.from('opaque key data');
	const key = {pem: bytes, passphrase: 'key password'};
	const pfx = {buffer: bytes, passphrase: 'pfx password'};
	const options = new Options({https: {key: [key], pfx: [pfx]}});
	const clone = new Options(undefined, undefined, options);
	const clonedKey = (clone.https.key as Array<typeof key>)[0]!;
	const clonedPfx = (clone.https.pfx as Array<typeof pfx>)[0]!;
	clonedKey.passphrase = 'changed key';
	clonedPfx.passphrase = 'changed pfx';

	assert.deepStrictEqual(options.https.key, [key]);
	assert.deepStrictEqual(options.https.pfx, [pfx]);
	assert.strictEqual(clonedKey.pem, bytes);
	assert.strictEqual(clonedPfx.buffer, bytes);
});

test('immutable TLS defaults freeze owned descriptors and allow mutable request clones', _t => {
	const bytes = Buffer.from('opaque key data');
	const key = {pem: bytes, passphrase: 'original'};
	const pfx = {buffer: bytes, passphrase: 'original'};
	const client = got.extend({https: {key: [key], pfx: [pfx], alpnProtocols: ['h2']}});
	const defaults = client.defaults.options.https;
	assert.strictEqual(Object.isFrozen(defaults.key), true);
	assert.strictEqual(Object.isFrozen((defaults.key as Array<typeof key>)[0]!), true);
	assert.strictEqual(Object.isFrozen(defaults.pfx), true);
	assert.strictEqual(Object.isFrozen((defaults.pfx as Array<typeof pfx>)[0]!), true);
	assert.strictEqual(Object.isFrozen(bytes), false);
	assert.strictEqual(Object.isFrozen(key), false);
	assert.strictEqual(Object.isFrozen(pfx), false);
	key.passphrase = 'caller';
	pfx.passphrase = 'caller';
	assert.strictEqual((defaults.key as Array<typeof key>)[0]!.passphrase, 'original');
	assert.strictEqual((defaults.pfx as Array<typeof pfx>)[0]!.passphrase, 'original');

	const clone = new Options(undefined, undefined, client.defaults.options);
	(clone.https.key as Array<typeof key>)[0]!.passphrase = 'request';
	clone.https.alpnProtocols!.push('http/1.1');
	assert.strictEqual((defaults.key as Array<typeof key>)[0]!.passphrase, 'original');
	assert.deepStrictEqual(defaults.alpnProtocols, ['h2']);
});

test('TLS extension history owns caller lists and descriptors', _t => {
	const key = {pem: 'key', passphrase: 'original'};
	const protocols = ['h2'];
	const parent = got.extend({https: {key: [key], alpnProtocols: protocols}});
	key.passphrase = 'caller';
	protocols.push('caller');
	const child = got.extend(parent, {https: {rejectUnauthorized: false}});

	assert.deepStrictEqual(child.defaults.options.https.key, [{pem: 'key', passphrase: 'original'}]);
	assert.deepStrictEqual(child.defaults.options.https.alpnProtocols, ['h2']);
	assert.strictEqual(child.defaults.options.https.rejectUnauthorized, false);
});

test('setting an internal header to undefined removes it', _t => {
	const options = new Options({headers: {'content-type': 'text/plain'}});
	options.setInternalHeader('content-type', undefined);

	assert.strictEqual('content-type' in options.headers, false);
	assert.strictEqual('content-type' in options.getInternalHeaders(), false);
});

test('should merge options replacing responseType', _t => {
	const responseType = 'json';
	const options = new Options({
		responseType,
	}, undefined, got.defaults.options);

	assert.strictEqual(options.responseType, responseType);
});

test('no duplicated searchParams values', _t => {
	const options = new Options({
		searchParams: 'string=true&noDuplication=true',
	}, {
		searchParams: new URLSearchParams({
			instance: 'true',
			noDuplication: 'true',
		}),
	});

	const searchParameters = options.searchParams as URLSearchParams;

	assert.strictEqual(searchParameters.get('string'), 'true');
	assert.strictEqual(searchParameters.get('instance'), 'true');
	assert.strictEqual(searchParameters.getAll('noDuplication').length, 1);
});

test('should copy non-numerable properties', _t => {
	const options = {
		json: {hello: '123'},
	};

	const merged = new Options(options, undefined, got.defaults.options);
	const mergedTwice = new Options(undefined, undefined, merged);

	assert.strictEqual(mergedTwice.json, options.json);
});

test('should get username and password from the URL', _t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
	});

	assert.strictEqual(options.username, 'user');
	assert.strictEqual(options.password, 'pass');
});

test('should get username and password from the options', _t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
		username: 'user_OPT',
		password: 'pass_OPT',
	});

	assert.strictEqual(options.username, 'user_OPT');
	assert.strictEqual(options.password, 'pass_OPT');
});

test('should get username and password from the merged options', _t => {
	const options = new Options(
		{
			url: 'http://user:pass@localhost:41285',
		},
		{
			username: 'user_OPT_MERGE',
			password: 'pass_OPT_MERGE',
		},
	);

	assert.strictEqual(options.username, 'user_OPT_MERGE');
	assert.strictEqual(options.password, 'pass_OPT_MERGE');
});

test('null value in search params means empty', _t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: null,
		},
	});

	assert.strictEqual((options.url as URL).href, 'http://localhost/?foo=');
});

test('undefined value in search params means it does not exist', _t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: undefined,
		},
	});

	assert.strictEqual((options.url as URL).href, 'http://localhost/');
});

test('prefixUrl alone does not set url', _t => {
	const options = new Options({
		prefixUrl: 'https://example.com',
	});

	assert.strictEqual(options.url, undefined);
});

test('maxRetryAfter is calculated separately from request timeout', _t => {
	const options = new Options({
		timeout: {
			request: 1000,
		},
		retry: {
			maxRetryAfter: undefined,
		},
	});

	assert.strictEqual(options.retry.maxRetryAfter, undefined);

	options.merge({
		timeout: {
			request: 2000,
		},
	});

	assert.strictEqual(options.retry.maxRetryAfter, undefined);

	options.merge({
		retry: {
			maxRetryAfter: 300,
		},
	});

	assert.strictEqual(options.retry.maxRetryAfter, 300);
});

test('extending responseType', _t => {
	const instance1 = got.extend({
		prefixUrl: 'https://localhost',
		responseType: 'json',
	});

	const instance2 = got.extend({
		headers: {
			'x-test': 'test',
		},
	});

	const merged = instance1.extend(instance2);

	assert.strictEqual(merged.defaults.options.responseType, 'json');
});

test('searchParams - multiple values for one key', _t => {
	const searchParameters = new URLSearchParams();

	searchParameters.append('a', '100');
	searchParameters.append('a', '200');
	searchParameters.append('a', '300');

	const options = new Options({
		searchParams: searchParameters,
	});

	assert.deepStrictEqual(
		(options.searchParams as URLSearchParams).getAll('a'),
		['100', '200', '300'],
	);
});

test('searchParams - assigning a URLSearchParams clones it', _t => {
	const searchParameters = new URLSearchParams('foo=bar');

	const options = new Options();
	options.searchParams = searchParameters;

	// Mutating the caller-owned object must not leak into the stored options.
	searchParameters.set('foo', 'changed');

	assert.strictEqual(options.searchParams.toString(), 'foo=bar');
});

test('__proto__ in options does not cause prototype pollution', _t => {
	const malicious = JSON.parse('{"method": "POST", "__proto__": {"injected": true}}');
	const options = new Options('https://example.com', malicious);

	assert.strictEqual(Object.getPrototypeOf(options), Options.prototype);
	assert.strictEqual(options.method, 'POST');
	assert.strictEqual(typeof options.getInternalHeaders, 'function');
	assert.strictEqual(({} as any).injected, undefined);
});

test('__proto__ in merge() does not cause prototype pollution', _t => {
	const options = new Options('https://example.com');
	const malicious = JSON.parse('{"__proto__": {"injected": true}}');
	options.merge(malicious);

	assert.strictEqual(Object.getPrototypeOf(options), Options.prototype);
	assert.strictEqual(options.method, 'GET');
	assert.strictEqual(typeof options.getInternalHeaders, 'function');
	assert.strictEqual(({} as any).injected, undefined);
});

test('__proto__ in nested option objects does not cause prototype pollution', _t => {
	const options = new Options('https://example.com');

	options.merge(JSON.parse('{"retry": {"__proto__": {"evil": true}}}'));
	assert.strictEqual((options.retry as any).evil, undefined);

	options.merge(JSON.parse('{"timeout": {"__proto__": {"evil": true}}}'));
	assert.strictEqual((options.timeout as any).evil, undefined);

	options.merge(JSON.parse('{"agent": {"__proto__": {"evil": true}}}'));
	assert.strictEqual((options.agent as any).evil, undefined);

	options.merge(JSON.parse('{"https": {"__proto__": {"evil": true}}}'));
	assert.strictEqual((options.https as any).evil, undefined);

	options.merge(JSON.parse('{"cacheOptions": {"__proto__": {"evil": true}}}'));
	assert.strictEqual((options.cacheOptions as any).evil, undefined);

	options.merge(JSON.parse('{"context": {"__proto__": {"evil": true}}}'));
	assert.strictEqual((options.context as any).evil, undefined);

	options.merge(JSON.parse('{"headers": {"__proto__": "leaked"}}'));
	assert.strictEqual(Object.hasOwn(options.headers, '__proto__'), false);

	assert.strictEqual(({} as any).evil, undefined);
});

test('__proto__ in searchParams does not cause prototype pollution', _t => {
	const malicious = JSON.parse('{"searchParams": {"__proto__": {"evil": true}, "valid": "ok"}}');
	const options = new Options('https://example.com', malicious);

	assert.strictEqual(({} as any).evil, undefined);
	const searchParameters = options.searchParams as URLSearchParams;
	assert.strictEqual(searchParameters.get('valid'), 'ok');
	assert.strictEqual(searchParameters.get('__proto__'), null);
});

if (globalThis.AbortSignal !== undefined) {
	test('signal does not get frozen', _t => {
		const controller = new AbortController();
		const {signal} = controller;

		const options = new Options({
			url: new URL('http://localhost'),
			signal,
		});
		options.freeze();

		assert.strictEqual(Object.isFrozen(options.signal), false);
	});
}

test('merging nested objects resets inherited values for explicitly undefined members', _t => {
	const agent = {http: new Agent({keepAlive: true})};
	const timeout = {connect: 500};
	const https = {serverName: 'example.com'};
	const cacheOptions = {shared: true};
	const options = new Options({
		agent,
		timeout,
		https,
		cacheOptions,
	});

	// Unlike scalar options, nested objects reset member-wise on an explicit `undefined`. See "Resetting options" in the options documentation.
	options.merge({agent: {http: undefined}});
	assert.strictEqual(options.agent.http, undefined);
	assert.strictEqual(options.agent.https, undefined);

	options.merge({timeout: {connect: undefined}});
	assert.strictEqual(options.timeout.connect, undefined);

	options.merge({https: {serverName: undefined}});
	assert.strictEqual(options.https.serverName, undefined);

	options.merge({cacheOptions: {shared: undefined}});
	assert.strictEqual(options.cacheOptions.shared, undefined);
});

test('assigning a partial retry object keeps the other retry defaults', _t => {
	const defaults = new Options().retry;
	const options = new Options();

	options.retry = {limit: 5};

	assert.strictEqual(options.retry.limit, 5);
	assert.deepStrictEqual(options.retry.methods, defaults.methods);
	assert.deepStrictEqual(options.retry.statusCodes, defaults.statusCodes);
	assert.deepStrictEqual(options.retry.errorCodes, defaults.errorCodes);
	assert.strictEqual(options.retry.noise, defaults.noise);
	assert.strictEqual(options.retry.enforceRetryRules, defaults.enforceRetryRules);
});

test('assigning a partial pagination object keeps the other pagination defaults', _t => {
	const defaults = new Options().pagination;
	const options = new Options();
	const paginate = (): false => false;

	options.pagination = {paginate};

	assert.strictEqual(options.pagination.paginate, paginate);
	assert.strictEqual(options.pagination.transform, defaults.transform);
	assert.strictEqual(options.pagination.filter, defaults.filter);
	assert.strictEqual(options.pagination.shouldContinue, defaults.shouldContinue);
	assert.strictEqual(options.pagination.countLimit, defaults.countLimit);
	assert.strictEqual(options.pagination.requestLimit, defaults.requestLimit);
	assert.strictEqual(options.pagination.backoff, defaults.backoff);
	assert.strictEqual(options.pagination.stackAllItems, defaults.stackAllItems);
});

test('changing prefixUrl throws when url no longer includes it', _t => {
	const options = new Options('https://a.com/foo/bar', {});
	options.prefixUrl = 'https://a.com/foo/';
	options.url = 'https://b.com/other';

	assert.throws(() => {
		options.prefixUrl = 'https://c.com/new/';
	}, errorMatching(Error, {message: 'The `url` option must include the `prefixUrl` option'}));
});

test('changing prefixUrl preserves path when url includes it', _t => {
	const options = new Options('other', {prefixUrl: 'https://a.com/foo/'});
	options.prefixUrl = 'https://c.com/new/';

	assert.strictEqual((options.url as URL).href, 'https://c.com/new/other');
});

test('changing prefixUrl throws on same-origin path mismatch', _t => {
	const options = new Options('https://a.com/other/path', {});
	options.prefixUrl = 'https://a.com/foo/';

	assert.throws(() => {
		options.prefixUrl = 'https://c.com/new/';
	}, errorMatching(Error, {message: 'The `url` option must include the `prefixUrl` option'}));
});

test('changing prefixUrl preserves query and hash', _t => {
	const options = new Options('bar?x=1#s', {prefixUrl: 'https://a.com/foo/'});
	options.prefixUrl = 'https://c.com/new/';

	assert.strictEqual((options.url as URL).href, 'https://c.com/new/bar?x=1#s');
});

test('replacing nested options does not remove supported option names', _t => {
	const options = new Options();

	options.timeout = {request: 1000};
	options.timeout = {connect: 500};
	assert.deepStrictEqual(options.timeout, {connect: 500});

	options.agent = {http: false};
	options.agent = {https: false};
	assert.deepStrictEqual(options.agent, {https: false});

	options.https = {minVersion: 'TLSv1.2'};
	options.https = {maxVersion: 'TLSv1.3'};
	assert.deepStrictEqual(options.https, {maxVersion: 'TLSv1.3'});

	options.cacheOptions = {shared: false};
	options.cacheOptions = {cacheHeuristic: 0.5};
	assert.deepStrictEqual(options.cacheOptions, {cacheHeuristic: 0.5});
});

test('merging nested options after replacement accepts every supported key', _t => {
	const options = new Options();
	options.timeout = {};
	options.agent = {};
	options.https = {};
	options.cacheOptions = {};

	const defaults = new Options();
	options.merge({
		timeout: defaults.timeout,
		agent: defaults.agent,
		https: defaults.https,
		cacheOptions: defaults.cacheOptions,
	});

	assert.deepStrictEqual(options.timeout, defaults.timeout);
	assert.deepStrictEqual(options.agent, defaults.agent);
	assert.deepStrictEqual(options.https, defaults.https);
	assert.deepStrictEqual(options.cacheOptions, defaults.cacheOptions);
});

test('replacing nested options still rejects unknown option names', _t => {
	const options = new Options();
	options.timeout = {};
	options.agent = {};
	options.https = {};
	options.cacheOptions = {};

	for (const name of ['timeout', 'agent', 'https', 'cacheOptions'] as const) {
		assert.throws(() => {
			// @ts-expect-error Testing unknown option names.
			options[name] = {unknown: true};
		}, {message: /Unexpected|does not exist/v});
	}
});

test('cloning normalized options isolates URL mutations', _t => {
	const original = new Options('https://example.com/items?page=1#original');
	const clone = new Options(undefined, undefined, original);

	(clone.url as URL).pathname = '/other';
	(clone.searchParams as URLSearchParams).set('page', '2');
	(clone.url as URL).hash = '#clone';

	assert.strictEqual((original.url as URL).href, 'https://example.com/items?page=1#original');
	assert.strictEqual((clone.url as URL).href, 'https://example.com/other?page=2#clone');
});

test('cloning options preserves query encoding without normalizing it', _t => {
	const original = new Options('https://example.com/?query=a%20b&query=second');
	const clone = new Options(undefined, undefined, original);

	assert.notStrictEqual(clone.url, original.url);
	assert.strictEqual((clone.url as URL).search, '?query=a%20b&query=second');
	assert.deepStrictEqual((clone.searchParams as URLSearchParams).getAll('query'), ['a b', 'second']);
});

test('merging search parameters into a clone leaves the original URL intact', _t => {
	const original = new Options('https://example.com/?page=1&keep=yes');
	const clone = new Options(undefined, {searchParams: {page: 2}}, original);

	assert.strictEqual((clone.url as URL).search, '?keep=yes&page=2');
	assert.strictEqual((original.url as URL).search, '?page=1&keep=yes');
});

test('assigning header arrays copies values while preserving header normalization', _t => {
	const values = ['first', 'second'];
	const options = new Options();
	options.headers = {'X-Values': values, 'X-Single': 'value', 'X-Omitted': undefined};
	values.push('caller');

	assert.deepStrictEqual(options.headers['x-values'], ['first', 'second']);
	assert.strictEqual(options.headers['x-single'], 'value');
	assert.strictEqual(options.headers['x-omitted'], undefined);

	(options.headers['x-values']).push('options');
	assert.deepStrictEqual(values, ['first', 'second', 'caller']);
});

test('merging header arrays does not retain caller or previous array values', _t => {
	const options = new Options({headers: {'x-values': ['original']}});
	const values = ['replacement'];
	options.merge({headers: {'x-values': values}});
	values.push('caller');

	assert.deepStrictEqual(options.headers['x-values'], ['replacement']);
});

test('cloning options copies empty and populated header arrays', _t => {
	const original = new Options({headers: {'x-empty': [], 'x-values': ['original']}});
	const clone = new Options(undefined, undefined, original);
	(clone.headers['x-empty'] as string[]).push('clone');
	(clone.headers['x-values'] as string[]).push('clone');

	assert.deepStrictEqual(original.headers['x-empty'], []);
	assert.deepStrictEqual(original.headers['x-values'], ['original']);
});

test('re-extending retains the header arrays captured from the original input', _t => {
	const values = ['original'];
	const first = got.extend({headers: {'x-values': values}});
	values.push('caller');
	const second = got.extend(first);

	assert.deepStrictEqual(second.defaults.options.headers['x-values'], ['original']);
});

test('reading unset search parameters on frozen defaults does not throw', _t => {
	const instance = got.extend();

	assert.strictEqual((instance.defaults.options.searchParams as URLSearchParams).size, 0);
});

test('reading unset frozen search parameters does not create a query override', _t => {
	const defaults = new Options();
	defaults.freeze();

	assert.strictEqual((defaults.searchParams as URLSearchParams).size, 0);
	const options = new Options('https://example.com/?query=preserved', undefined, defaults);
	assert.strictEqual((options.url as URL).search, '?query=preserved');
});

// A frozen instance hands out a copy, so a write to what it returns cannot reach its state.
test('a write through the frozen searchParams getter is discarded', _t => {
	const defaults = new Options(undefined, {searchParams: {token: 'abc'}});
	defaults.freeze();
	const read = (): URLSearchParams => defaults.searchParams as URLSearchParams;

	assert.strictEqual(read().get('token'), 'abc');
	assert.notStrictEqual(read(), read());

	read().set('leaked', 'yes');

	assert.strictEqual(read().get('leaked'), null);
	assert.strictEqual(read().size, 1);
});

test('frozen defaults retain configured search parameters', _t => {
	const instance = got.extend({searchParams: 'page=1&page=2'});
	const parameters = instance.defaults.options.searchParams as URLSearchParams;

	assert.deepStrictEqual(parameters.getAll('page'), ['1', '2']);
});

test('reading unset mutable search parameters still permits configuring defaults', _t => {
	const defaults = new Options();
	(defaults.searchParams as URLSearchParams).set('page', '2');
	const options = new Options('https://example.com/', undefined, defaults);

	assert.strictEqual((options.url as URL).search, '?page=2');
});

test('merging undefined search parameters clears the current normalized URL query', _t => {
	const options = new Options('https://example.com/?page=1&page=2');
	options.merge({searchParams: undefined});

	assert.strictEqual((options.url as URL).search, '');
});

test('immutable instance defaults prevent changing pagination settings', _t => {
	const instance = got.extend({pagination: {countLimit: 10}});

	assert.throws(() => {
		instance.defaults.options.pagination.countLimit = 0;
	}, TypeError);
});

test('cloning frozen options produces independent mutable pagination settings', _t => {
	const original = new Options({pagination: {countLimit: 10}});
	original.freeze();
	const clone = new Options(undefined, undefined, original);
	clone.pagination.countLimit = 1;

	assert.strictEqual(original.pagination.countLimit, 10);
	assert.strictEqual(clone.pagination.countLimit, 1);
});

test('native PFX options preserve raw entries mixed with object entries', _t => {
	const bytes = new Uint8Array([1, 2, 3]);
	const options = new Options('https://example.com/', {https: {pfx: [{buffer: bytes}, bytes]}});

	assert.deepStrictEqual(options.createNativeRequestOptions().pfx, [{buf: bytes, passphrase: undefined}, bytes]);
});

test('native PFX options convert object entries after raw entries', _t => {
	const bytes = new Uint8Array([1, 2, 3]);
	const object = {buffer: bytes, passphrase: 'synthetic'};
	const entries = ['synthetic', bytes, object];
	const options = new Options('https://example.com/', {https: {pfx: entries}});

	assert.deepStrictEqual(options.createNativeRequestOptions().pfx, ['synthetic', bytes, {buf: bytes, passphrase: 'synthetic'}]);
	assert.deepStrictEqual(options.https.pfx, entries);
	assert.deepStrictEqual(object, {buffer: bytes, passphrase: 'synthetic'});
});

test('native PFX options preserve homogeneous raw arrays and empty arrays', _t => {
	for (const entries of [[], ['synthetic'], [new Uint8Array([1, 2, 3])]]) {
		const options = new Options('https://example.com/', {https: {pfx: entries}});

		assert.deepStrictEqual(options.createNativeRequestOptions().pfx, entries);
	}
});

test('native PFX options preserve per-entry passphrases', _t => {
	const options = new Options('https://example.com/', {
		https: {
			passphrase: 'default',
			pfx: [{buffer: 'first'}, {buffer: 'second', passphrase: ''}, {buffer: 'third', passphrase: 'specific'}],
		},
	});
	const nativeOptions = options.createNativeRequestOptions();

	assert.deepStrictEqual(nativeOptions.pfx, [{buf: 'first', passphrase: undefined}, {buf: 'second', passphrase: ''}, {buf: 'third', passphrase: 'specific'}]);
	assert.strictEqual(nativeOptions.passphrase, 'default');
});

test('standalone Uint8Array PFX options are accepted', _t => {
	const bytes = new Uint8Array([1, 2, 3]);
	const options = new Options('https://example.com/', {https: {pfx: bytes}});

	assert.strictEqual(options.createNativeRequestOptions().pfx, bytes);
});

test('standalone PFX byte arrays preserve subarray boundaries and empty values', _t => {
	const bytes = new Uint8Array([0, 1, 2, 3]);

	for (const value of [bytes.subarray(1, 3), bytes.subarray(2, 2)]) {
		const options = new Options('https://example.com/', {https: {pfx: value}});

		assert.strictEqual(options.createNativeRequestOptions().pfx, value);
	}
});

test('standalone PFX still accepts Buffer and string values', _t => {
	for (const value of [Buffer.alloc(3, 1), 'synthetic']) {
		const options = new Options('https://example.com/', {https: {pfx: value}});

		assert.strictEqual(options.createNativeRequestOptions().pfx, value);
	}
});

test('standalone PFX rejects non-byte typed arrays', _t => {
	const options = new Options();

	assert.throws(() => {
		// @ts-expect-error PFX accepts byte arrays, not arbitrary typed arrays.
		options.https = {pfx: new Uint16Array([1, 2])};
	}, {message: /Option 'https\.pfx'/v});
});

test('undefined retry methods preserve inherited methods', _t => {
	const options = new Options({retry: {methods: ['POST']}});
	options.merge({retry: {methods: undefined}});

	assert.deepStrictEqual(options.retry.methods, ['POST']);
});

for (const merge of [false, true]) {
	test(`undefined retry settings preserve required values with merge ${merge}`, _t => {
		const options = new Options({
			retry: {
				limit: 5,
				methods: ['POST'],
				statusCodes: [503],
				errorCodes: ['ECONNRESET'],
				calculateDelay: () => 1,
				backoffLimit: 25,
				noise: 0,
				enforceRetryRules: false,
				maxRetryAfter: 30,
			},
		});
		const original = {...options.retry};
		const retry = Object.freeze({
			limit: undefined,
			methods: undefined,
			statusCodes: undefined,
			errorCodes: undefined,
			calculateDelay: undefined,
			backoffLimit: undefined,
			noise: undefined,
			enforceRetryRules: undefined,
			maxRetryAfter: undefined,
		});

		if (merge) {
			options.merge({retry});
		} else {
			options.retry = retry;
		}

		assert.deepStrictEqual(options.retry, {...original, maxRetryAfter: undefined});
	});
}

test('explicit retry values can still clear arrays and disable retry settings', _t => {
	const options = new Options();
	const retry = {
		limit: 0,
		methods: [],
		statusCodes: [],
		errorCodes: [],
		calculateDelay: () => 0,
		backoffLimit: 0,
		noise: 0,
		enforceRetryRules: false,
		maxRetryAfter: 0,
	};
	options.merge({retry});

	assert.deepStrictEqual(options.retry, retry);
});

test('immutable default header arrays reject mutation', _t => {
	const instance = got.extend({headers: {'x-values': ['first']}});

	assert.throws(() => {
		(instance.defaults.options.headers['x-values'] as string[]).push('second');
	}, TypeError);
});

test('freezing headers handles empty arrays and scalar values', _t => {
	const options = new Options({headers: {'x-empty': [], 'x-single': 'value', 'x-omitted': undefined}});
	options.freeze();

	assert.throws(() => {
		(options.headers['x-empty'] as string[]).push('value');
	}, TypeError);
	assert.strictEqual(options.headers['x-single'], 'value');
	assert.strictEqual(options.headers['x-omitted'], undefined);
});

test('custom method names normalize request and retry methods', _t => {
	// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- Verify callers can supply a general string.
	const method: string = 'propfind';
	const options = new Options({method, retry: {methods: [method, 'PROPFIND', 'REPORT']}});

	assert.strictEqual(options.method, 'PROPFIND');
	assert.deepStrictEqual(options.retry.methods, ['PROPFIND', 'REPORT']);
});

test('custom method support still rejects non-string values', _t => {
	assert.throws(() => new Options({
		// @ts-expect-error Methods must be strings.
		method: 123,
	}), TypeError);
});

test('normalized searchParams supports URLSearchParams methods and all input forms', async _t => {
	let calls = 0;
	await got('https://example.com/?page=1', {
		hooks: {
			beforeRequest: [options => {
				calls++;
				expectTypeOf(options.searchParams).toEqualTypeOf<URLSearchParams>();
				options.searchParams.set('page', '2');
				assert.strictEqual(options.searchParams.get('page'), '2');
				options.searchParams = {page: 3};
				assert.strictEqual(options.searchParams.get('page'), '3');
				options.searchParams = 'page=4';
				assert.strictEqual(options.searchParams.get('page'), '4');
				options.searchParams = undefined;
				assert.strictEqual(options.searchParams.size, 0);
				return new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('ok'),
					url: 'https://example.com',
				});
			}],
		},
	});

	assert.strictEqual(calls, 1);
});

test('undefined scalar option preserves the parent value instead of resetting it', _t => {
	const defaults = new Options({followRedirect: false});
	const options = new Options(undefined, {followRedirect: undefined}, defaults);

	assert.strictEqual(options.followRedirect, false);
});

test('normalized cache options support the documented setter inputs in hooks', async _t => {
	expectTypeOf<string>().toExtend<NormalizedOptions['cache']>();

	let calls = 0;
	await got('https://example.com', {
		hooks: {
			beforeRequest: [options => {
				calls++;
				options.cache = 'sqlite://cache';
				assert.strictEqual(options.cache, 'sqlite://cache');
				options.cache = true;
				assert.strictEqual(options.cache instanceof Map, true);
				options.cache = false;
				assert.strictEqual(options.cache, undefined);
				return new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('ok'),
					url: 'https://example.com',
				});
			}],
		},
	});

	assert.strictEqual(calls, 1);
});

// `searchParams` overrides the query string in the url, so an `undefined` value must not keep
// the rest of it. Only a merge into existing options clears just that key.
for (const [name, apply, expected] of [
	['the constructor', () => new Options('http://example.com/?a=1&b=2', {searchParams: {a: undefined}}), ''],
	['an assignment', () => {
		const assigned = new Options('http://example.com/?a=1&b=2');
		assigned.searchParams = {a: undefined};
		return assigned;
	}, ''],
	['a merge', () => {
		const merged = new Options('http://example.com/?a=1&b=2');
		merged.merge({searchParams: {a: undefined}});
		return merged;
	}, '?b=2'],
] as Array<[string, () => Options, string]>) {
	test(`searchParams \`undefined\` through ${name}`, _t => {
		assert.strictEqual(apply().url!.search, expected);
	});
}

test('searchParams overrides the query string whether or not a value is undefined', _t => {
	assert.strictEqual(new Options('http://example.com/?drop=this', {searchParams: {test: 'wow'}}).url!.search, '?test=wow');
	assert.strictEqual(new Options('http://example.com/?keep=this&drop=this', {searchParams: {test: 'wow'}}).url!.search, '?test=wow');
	assert.strictEqual(new Options('http://example.com/?a=1&b=2', {searchParams: {a: undefined, c: 3}}).url!.search, '?c=3');
	assert.strictEqual(new Options('http://example.com/?a=1&b=2', {searchParams: {c: 3, d: undefined}}).url!.search, '?c=3');
});

// `in` walks the prototype chain, so inherited names passed the "unexpected key" guards and
// were then written onto the live option objects.
for (const [name, options, message] of [
	['toString', {toString: 'x'}, 'Unexpected option: toString'],
	['constructor', {constructor: 'x'}, 'Unexpected option: constructor'],
	['valueOf', {valueOf: 'x'}, 'Unexpected option: valueOf'],
	['hooks.toString', {hooks: {toString: []}}, 'Unexpected hook event: toString'],
	['hooks.hasOwnProperty', {hooks: {hasOwnProperty: []}}, 'Unexpected hook event: hasOwnProperty'],
	['retry.hasOwnProperty', {retry: {hasOwnProperty: 5}}, 'Unexpected retry option: hasOwnProperty'],
	['timeout.toString', {timeout: {toString: 1}}, 'Unexpected timeout option: toString'],
	['agent.toString', {agent: {toString: {}}}, 'Unexpected agent option: toString'],
	['cacheOptions.toString', {cacheOptions: {toString: 1}}, 'Cache option `toString` does not exist'],
	['https.toString', {https: {toString: 'x'}}, 'HTTPS option `toString` does not exist'],
] as Array<[string, Record<string, unknown>, string]>) {
	test(`rejects the inherited option name ${name}`, _t => {
		assert.throws(() => new Options('http://example.com/', options), {message});
	});
}

test('an inherited option name cannot shadow an Options method', _t => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	assert.throws(() => new Options('http://example.com/', {toJSON: 'x'} as any), {message: 'Unexpected option: toJSON'});
	assert.throws(() => new Options('http://example.com/', {clearBody: 'x'} as any), {message: 'Unexpected option: clearBody'});
});

// The retry array options are only checked as arrays, so a wrong member type silently
// disables retries instead of being reported.
for (const [name, retry, message] of [
	['a non-string method', {methods: [1]}, /Expected values which are `string`\. Received values of type `number`\./v],
	['a string status code', {statusCodes: ['500']}, /Expected values which are `number`\. Received values of type `string`\./v],
	['a non-string error code', {errorCodes: [500]}, /Expected values which are `string`\. Received values of type `number`\./v],
	['a non-number backoffLimit', {backoffLimit: 'abc'}, /Expected values which are `number` or `undefined`\. Received values of type `string`\./v],
	['a boolean backoffLimit', {backoffLimit: true}, /Expected values which are `number` or `undefined`\. Received values of type `boolean`\./v],
] as Array<[string, Record<string, unknown>, RegExp]>) {
	test(`rejects ${name}`, _t => {
		assert.throws(() => new Options('http://example.com/', {retry}), {message});
	});
}

// The URL parser strips leading C0 control characters and spaces, so the protocol guard
// has to see the normalized string.
for (const prefix of ['', ' ', String.fromCodePoint(9), String.fromCodePoint(10), String.fromCodePoint(13)]) {
	test(`rejects a url whose protocol follows ${JSON.stringify(prefix)} instead of slashes`, _t => {
		assert.throws(() => new Options(`${prefix}https:evil.example/`), {message: '`url` protocol must be followed by `//`'});
	});
}

// A `URL`, `Map` or `Set` has no enumerable own keys, so accepting it erased the query
// string instead of reporting a wrong option.
for (const [name, value] of [
	['a URL', new URL('http://other.example/?z=9')],
	['an array', ['a', 'b']],
	['a Map', new Map([['a', '1']])],
	['a Set', new Set(['a'])],
] as Array<[string, unknown]>) {
	test(`searchParams rejects ${name}`, _t => {
		const options = new Options('http://example.com/?keep=1');

		assert.throws(() => {
			options.searchParams = value as never;
		}, {message: /Expected value which is `plain object`/v});
		assert.strictEqual(options.url!.search, '?keep=1');
	});
}

// `undefined` values are ignored everywhere else, so a hook event assigned `undefined`
// must not be an error.
test('a hook event assigned undefined is ignored', _t => {
	const hook = () => {};
	const options = new Options('http://example.com/', {hooks: {beforeRequest: [hook]}});

	options.hooks = {beforeRequest: undefined} as unknown as NormalizedOptions['hooks'];

	assert.deepStrictEqual(options.hooks.beforeRequest, [hook]);
});

test('a hook event merged as undefined is ignored', _t => {
	const hook = () => {};
	const options = new Options('http://example.com/', {hooks: {beforeRequest: [hook]}});

	options.merge({hooks: {beforeRequest: undefined}});

	assert.deepStrictEqual(options.hooks.beforeRequest, [hook]);
});

test('a hook event can still be replaced with an empty array', _t => {
	const options = new Options('http://example.com/', {hooks: {beforeRequest: [() => {}]}});

	options.hooks = {beforeRequest: []} as unknown as NormalizedOptions['hooks'];

	assert.deepStrictEqual(options.hooks.beforeRequest, []);
});

// These are counts, so a negative or fractional value is a mistake worth reporting.
for (const [name, options, message] of [
	['a negative maxRedirects', {maxRedirects: -1}, 'Option \'maxRedirects\': Expected values which are `non-negative integer`. Received values of type `number`.'],
	['a fractional maxRedirects', {maxRedirects: 1.5}, 'Option \'maxRedirects\': Expected values which are `non-negative integer`. Received values of type `number`.'],
	['a negative retry limit', {retry: {limit: -1}}, 'Option \'retry.limit\': Expected values which are `non-negative integer`. Received values of type `number`.'],
	['a fractional retry limit', {retry: {limit: 1.5}}, 'Option \'retry.limit\': Expected values which are `non-negative integer`. Received values of type `number`.'],
] as Array<[string, Record<string, unknown>, string]>) {
	test(`rejects ${name}`, _t => {
		assert.throws(() => new Options('http://example.com/', options), {message});
	});
}

// `Infinity` is the "never" value a count needs on top of the plain numbers, so it is the only
// one of these the plain number check would have rejected.
for (const [name, options, read] of [
	['maxRedirects', {maxRedirects: Infinity}, (options: Options) => options.maxRedirects],
	['retry limit', {retry: {limit: Infinity}}, (options: Options) => options.retry.limit],
] as Array<[string, Record<string, unknown>, (options: Options) => number | undefined]>) {
	test(`accepts an infinite ${name}`, _t => {
		assert.strictEqual(read(new Options('http://example.com/', options)), Infinity);
	});
}

// `undefined` is only a count for the options whose type allows it, so it must not be
// rejected the way a negative number is.
test('an undefined retry limit is not rejected as a count', _t => {
	const options = new Options('http://example.com/', {retry: {limit: 3}});

	assert.doesNotThrow(() => {
		options.retry = {limit: undefined};
	});
	assert.strictEqual(options.retry.limit, 3);
});

// A rejected url must not be left on the instance, or a hook that catches the error leaves
// the options in a state the request code treats as valid.
for (const [name, url, message] of [
	['an unsupported protocol', 'ftp://other.example/', 'Unsupported protocol: ftp:'],
	['a unix socket without the opt-in', 'unix:///tmp/a.sock:/p', 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled'],
] as Array<[string, string, string]>) {
	test(`a rejected url with ${name} is not stored`, _t => {
		const options = new Options('http://example.com/');

		assert.throws(() => {
			options.url = url;
		}, {message});
		assert.strictEqual(options.url?.toString(), 'http://example.com/');
	});
}

// The prefix is concatenated with the path, so a query or a fragment would swallow it.
for (const prefixUrl of ['https://example.com/a?b=1', 'https://example.com/a#z']) {
	test(`rejects a prefixUrl containing ${JSON.stringify(prefixUrl)}`, _t => {
		const options = new Options('http://example.com/');

		assert.throws(() => {
			options.prefixUrl = prefixUrl;
		}, {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
		// A request built from such a prefix must not silently drop the path. The merge fails
		// while the url is assigned, before the prefix itself is checked.
		assert.throws(() => new Options('foo', {prefixUrl}), {message: 'Invalid URL'});
	});
}

for (const prefixUrl of ['https://example.com', 'https://example.com/', 'https://example.com/a/b', 'https://example.com/a%20b']) {
	test(`accepts a prefixUrl of ${JSON.stringify(prefixUrl)}`, _t => {
		assert.strictEqual(new Options('foo', {prefixUrl}).url?.toString(), `${prefixUrl.replace(/\/$/v, '')}/foo`);
	});
}

for (const value of ['garbage', 1, true]) {
	test(`rejects an h2session of ${JSON.stringify(value)}`, _t => {
		assert.throws(() => new Options('http://example.com/', {h2session: value} as never), {message: /Expected values which are `Object` or `undefined`/v});
	});
}

test('accepts an undefined h2session', _t => {
	assert.strictEqual(new Options('http://example.com/', {h2session: undefined}).h2session, undefined);
});

// `JSON.parse` creates an own `__proto__` property, which must not become a request header.
test('a __proto__ key in headers is dropped on assignment and in the constructor', _t => {
	const malicious = (): Record<string, string> => JSON.parse('{"__proto__": "x", "a": "b"}') as Record<string, string>;

	const assigned = new Options('http://example.com/');
	assigned.headers = malicious();
	assert.deepStrictEqual(Object.keys(assigned.getInternalHeaders()).filter(name => name === '__proto__'), []);

	const constructed = new Options('http://example.com/', {headers: malicious()});
	assert.deepStrictEqual(Object.keys(constructed.getInternalHeaders()).filter(name => name === '__proto__'), []);

	assert.strictEqual(({} as any).x, undefined);
	assert.strictEqual(Object.getPrototypeOf(assigned.getInternalHeaders()), Object.prototype);
});

// `cloneRaw` spreads the options, so the validation has to happen there too.
for (const [name, value] of [
	['a URL', new URL('http://other.example/?z=9')],
	['an array', ['a', 'b']],
	['a Map', new Map([['a', '1']])],
	['a Set', new Set(['a'])],
] as Array<[string, unknown]>) {
	test(`searchParams rejects ${name} passed as an option`, _t => {
		assert.throws(() => new Options('http://example.com/?keep=1', {searchParams: value} as never), {message: /Expected value which is `plain object`/v});
	});
}

// The internal HTTP/2 timeout phase must not reach a custom request function.
test('a custom request function does not see the internal timeout phase', async _t => {
	const internalKeys: string[][] = [];

	await got('https://example.com/', {
		http2: true,
		retry: {
			limit: 0,
		},
		timeout: {
			lookup: 100,
		},
		request(_url, nativeOptions) {
			internalKeys.push(Object.keys(nativeOptions as Record<string, unknown>).filter(name => name.startsWith('_')));
			return new ResponseLike({
				statusCode: 200,
				headers: {},
				body: Buffer.from('ok'),
				url: 'https://example.com/',
			});
		},
	});

	assert.deepStrictEqual(internalKeys, [[]]);
});

// `toJSON()` hands out a plain object, so editing it must not reach the options.
test('toJSON returns a copy of the nested state', _t => {
	const options = new Options('http://example.com/?a=1', {
		headers: {foo: 'bar'},
		context: {token: 'secret'},
		timeout: {request: 1000},
		hooks: {beforeRequest: [() => {}]},
	});

	const json = options.toJSON() as unknown as {headers: {foo: unknown}; context: {token: unknown}; timeout: {request: unknown}};
	json.headers.foo = 'mutated';
	json.context.token = 'mutated';
	json.timeout.request = 99;

	assert.strictEqual(options.headers.foo, 'bar');
	assert.strictEqual(options.context.token, 'secret');
	assert.strictEqual(options.timeout.request, 1000);
	assert.strictEqual(options.hooks.beforeRequest.length, 1);

	// The copy is still a complete, serializable description of the options.
	// eslint-disable-next-line unicorn/prefer-structured-clone -- The documented use is a JSON round-trip.
	const stored = JSON.parse(JSON.stringify(options.toJSON())) as {headers: {foo: string}; timeout: {request: number}; url: string};
	assert.strictEqual(stored.headers.foo, 'bar');
	assert.strictEqual(stored.timeout.request, 1000);
	assert.strictEqual(stored.url, 'http://example.com/?a=1');
});

// An empty method would be sent as the default `GET`, which hides the mistake. Node rejects
// the other malformed methods itself when the request is made.
test('rejects an empty method', _t => {
	assert.throws(() => new Options('http://example.com/', {method: ''}), {message: 'Option \'method\': Expected values which are `non-empty string`. Received values of type `string`.'});
	assert.strictEqual(new Options('http://example.com/', {method: ' '.repeat(3)}).method, ' '.repeat(3));
});

test('accepts a custom method and normalizes it to uppercase', _t => {
	assert.strictEqual(new Options('http://example.com/', {method: 'purge'}).method, 'PURGE');
});

// Every other `__proto__` path in `Options` is guarded, so the public headers proxy must be
// too: assigning it would re-prototype the live headers object.
test('a __proto__ header name is rejected', _t => {
	const options = new Options('http://example.com/');

	const injected = {polluted: 'yes'};
	assert.throws(() => {
		Reflect.set(options.headers, '__proto__', injected);
	}, {message: /__proto__/v});

	assert.deepStrictEqual(Object.keys(options.getInternalHeaders()), ['user-agent']);
	assert.strictEqual(Object.getPrototypeOf(options.getInternalHeaders()), Object.prototype);
	const empty: {polluted?: string} = {};
	assert.strictEqual(empty.polluted, undefined);
});

// An inherited `Object.prototype` member is not a header.
test('the headers view reports only own properties', _t => {
	const options: Options = new Options('http://example.com/');
	const read = (name: string): unknown => Reflect.get(options.headers, name);

	assert.strictEqual(read('toString'), undefined);
	assert.strictEqual(read('constructor'), undefined);
	assert.strictEqual(read('valueOf'), undefined);

	Reflect.set(options.headers, 'toString', 'clobbered');
	assert.strictEqual(read('toString'), 'clobbered');
	assert.strictEqual(Reflect.get(options.getInternalHeaders(), 'tostring'), 'clobbered');
});

// The plain object input carries the url, so one in the second argument is the same conflict
// the string input reports.
test('a url in the second argument is rejected for a plain object input', _t => {
	const secondArgument: {url: string} = {url: 'http://example.com/p'};
	assert.throws(() => new Options({method: 'POST'}, secondArgument), {
		message: 'The `url` option is mutually exclusive with the `input` argument',
	});

	assert.strictEqual(new Options({prefixUrl: 'http://example.com/'}).url, undefined);
});

// The native options are documented as a new object, so they must not share the headers.
test('createNativeRequestOptions returns a copy of the headers', _t => {
	const options = new Options('http://example.com/', {headers: {'x-a': '1'}});
	const native = options.createNativeRequestOptions();
	const nativeHeaders = native.headers as Record<string, string>;

	nativeHeaders['x-leak'] = 'yes';
	nativeHeaders['x-a'] = '2';

	assert.strictEqual(options.headers['x-a'], '1');
	assert.strictEqual(Object.hasOwn(options.getInternalHeaders(), 'x-leak'), false);
	assert.strictEqual(nativeHeaders['x-a'], '2');
	assert.strictEqual(nativeHeaders['x-leak'], 'yes');
});

// An `undefined` value clears a key the instance defaults set.
test('an undefined searchParams value clears the key inherited from the defaults', _t => {
	const defaults = new Options(undefined, {searchParams: {keep: 'yes', drop: 'yes'}});
	const options = new Options('http://example.com/?a=1', {searchParams: {drop: undefined}}, defaults);
	assert.strictEqual(options.url!.search, '?keep=yes');
});

// A key that is both in the url and in `searchParams` must be sent once, whichever was set first.
test('a searchParams key replaces the one already in the url', _t => {
	const merged = new Options('http://example.com/?a=1&b=2&c=9', {searchParams: {a: undefined, b: '3'}});
	assert.strictEqual(merged.url!.search, '?b=3');

	const assigned = new Options();
	assigned.url = 'http://example.com/?a=1&b=2&c=9';
	assigned.searchParams = {a: undefined, b: '3'};
	// TypeScript still narrows `assigned.url` to the string that was assigned, but the setter
	// normalises it to a `URL`, so compare the object rather than coercing a string.
	assert.deepStrictEqual(assigned.url, new URL('http://example.com/?b=3'));
});

// `context` is free-form user data, so unlike the option objects it takes an inherited name.
test('context accepts an inherited property name', _t => {
	const context = new Options('http://example.com/', {context: {toString: 'x'}});
	assert.strictEqual(Reflect.get(context.context, 'toString'), 'x');
});

// Assigning a frozen option throws, the same as every other option.
test('a frozen instance does not let searchParams rewrite its url', _t => {
	const options = new Options('http://example.com/?a=1&b=2');
	options.freeze();

	assert.throws(() => {
		options.searchParams = {a: undefined};
	}, TypeError);
	assert.throws(() => {
		options.searchParams = {c: '3'};
	}, TypeError);
	assert.throws(() => {
		options.searchParams = undefined;
	}, TypeError);

	// The getter is read-only too, so a write through it cannot reach the url either.
	(options.searchParams as URLSearchParams).set('c', '3');
	assert.strictEqual((options.searchParams as URLSearchParams).toString(), 'a=1&b=2');
	assert.strictEqual(String(options.url), 'http://example.com/?a=1&b=2');
});
