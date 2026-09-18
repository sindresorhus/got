import {Buffer} from 'node:buffer';
import test from 'ava';
import got, {Options} from '../source/index.js';

test('cloned options own their TLS protocol arrays', t => {
	const original = new Options({https: {alpnProtocols: ['h2', 'http/1.1']}});
	const clone = new Options(undefined, undefined, original);
	clone.https.alpnProtocols!.splice(0, 1);

	t.deepEqual(original.https.alpnProtocols, ['h2', 'http/1.1']);
	t.deepEqual(clone.https.alpnProtocols, ['http/1.1']);
});

test('immutable defaults protect TLS protocol arrays without freezing caller input', t => {
	const protocols = ['h2', 'http/1.1'];
	const client = got.extend({https: {alpnProtocols: protocols}});

	t.throws(() => {
		client.defaults.options.https.alpnProtocols!.push('custom');
	}, {instanceOf: TypeError});
	protocols.push('custom');
	t.deepEqual(client.defaults.options.https.alpnProtocols, ['h2', 'http/1.1']);
});

for (const property of ['certificateAuthority', 'certificate', 'certificateRevocationLists', 'alpnProtocols'] as const) {
	test(`TLS ${property} lists are isolated through assignment, merging, and cloning`, t => {
		const values = ['first'];
		const options = new Options({https: {[property]: values}});
		values.push('caller');
		t.deepEqual(options.https[property], ['first']);

		const assigned = ['assigned'];
		options.https = {[property]: assigned};
		assigned.push('caller');
		t.deepEqual(options.https[property], ['assigned']);

		const merged = ['merged'];
		options.merge({https: {[property]: merged}});
		merged.push('caller');
		const clone = new Options(undefined, undefined, options);
		(clone.https[property] as string[]).push('clone');
		t.deepEqual(options.https[property], ['merged']);
		t.deepEqual(clone.https[property], ['merged', 'clone']);
	});
}

test('TLS key and PFX descriptors are isolated while preserving binary data', t => {
	const bytes = Buffer.from('opaque key data');
	const key = {pem: bytes, passphrase: 'key password'};
	const pfx = {buffer: bytes, passphrase: 'pfx password'};
	const options = new Options({https: {key: [key], pfx: [pfx]}});
	const clone = new Options(undefined, undefined, options);
	const clonedKey = (clone.https.key as Array<typeof key>)[0]!;
	const clonedPfx = (clone.https.pfx as Array<typeof pfx>)[0]!;
	clonedKey.passphrase = 'changed key';
	clonedPfx.passphrase = 'changed pfx';

	t.deepEqual(options.https.key, [key]);
	t.deepEqual(options.https.pfx, [pfx]);
	t.is(clonedKey.pem, bytes);
	t.is(clonedPfx.buffer, bytes);
});

test('immutable TLS defaults freeze owned descriptors and allow mutable request clones', t => {
	const bytes = Buffer.from('opaque key data');
	const key = {pem: bytes, passphrase: 'original'};
	const pfx = {buffer: bytes, passphrase: 'original'};
	const client = got.extend({https: {key: [key], pfx: [pfx], alpnProtocols: ['h2']}});
	const defaults = client.defaults.options.https;
	t.true(Object.isFrozen(defaults.key));
	t.true(Object.isFrozen((defaults.key as Array<typeof key>)[0]!));
	t.true(Object.isFrozen(defaults.pfx));
	t.true(Object.isFrozen((defaults.pfx as Array<typeof pfx>)[0]!));
	t.false(Object.isFrozen(bytes));
	t.false(Object.isFrozen(key));
	t.false(Object.isFrozen(pfx));
	key.passphrase = 'caller';
	pfx.passphrase = 'caller';
	t.is((defaults.key as Array<typeof key>)[0]!.passphrase, 'original');
	t.is((defaults.pfx as Array<typeof pfx>)[0]!.passphrase, 'original');

	const clone = new Options(undefined, undefined, client.defaults.options);
	(clone.https.key as Array<typeof key>)[0]!.passphrase = 'request';
	clone.https.alpnProtocols!.push('http/1.1');
	t.is((defaults.key as Array<typeof key>)[0]!.passphrase, 'original');
	t.deepEqual(defaults.alpnProtocols, ['h2']);
});

test('TLS extension history owns caller lists and descriptors', t => {
	const key = {pem: 'key', passphrase: 'original'};
	const protocols = ['h2'];
	const parent = got.extend({https: {key: [key], alpnProtocols: protocols}});
	key.passphrase = 'caller';
	protocols.push('caller');
	const child = got.extend(parent, {https: {rejectUnauthorized: false}});

	t.deepEqual(child.defaults.options.https.key, [{pem: 'key', passphrase: 'original'}]);
	t.deepEqual(child.defaults.options.https.alpnProtocols, ['h2']);
	t.false(child.defaults.options.https.rejectUnauthorized);
});

test('setting an internal header to undefined removes it', t => {
	const options = new Options({headers: {'content-type': 'text/plain'}});
	options.setInternalHeader('content-type', undefined);

	t.false('content-type' in options.headers);
	t.false('content-type' in options.getInternalHeaders());
});

test('should merge options replacing responseType', t => {
	const responseType = 'json';
	const options = new Options({
		responseType,
	}, undefined, got.defaults.options);

	t.is(options.responseType, responseType);
});

test('no duplicated searchParams values', t => {
	const options = new Options({
		searchParams: 'string=true&noDuplication=true',
	}, {
		searchParams: new URLSearchParams({
			instance: 'true',
			noDuplication: 'true',
		}),
	});

	// eslint-disable-next-line unicorn/prevent-abbreviations
	const searchParams = options.searchParams as URLSearchParams;

	t.is(searchParams.get('string'), 'true');
	t.is(searchParams.get('instance'), 'true');
	t.is(searchParams.getAll('noDuplication').length, 1);
});

test('should copy non-numerable properties', t => {
	const options = {
		json: {hello: '123'},
	};

	const merged = new Options(options, undefined, got.defaults.options);
	const mergedTwice = new Options(undefined, undefined, merged);

	t.is(mergedTwice.json, options.json);
});

test('should get username and password from the URL', t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
	});

	t.is(options.username, 'user');
	t.is(options.password, 'pass');
});

test('should get username and password from the options', t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
		username: 'user_OPT',
		password: 'pass_OPT',
	});

	t.is(options.username, 'user_OPT');
	t.is(options.password, 'pass_OPT');
});

test('should get username and password from the merged options', t => {
	const options = new Options(
		{
			url: 'http://user:pass@localhost:41285',
		},
		{
			username: 'user_OPT_MERGE',
			password: 'pass_OPT_MERGE',
		},
	);

	t.is(options.username, 'user_OPT_MERGE');
	t.is(options.password, 'pass_OPT_MERGE');
});

test('null value in search params means empty', t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: null,
		},
	});

	t.is((options.url as URL).href, 'http://localhost/?foo=');
});

test('undefined value in search params means it does not exist', t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: undefined,
		},
	});

	t.is((options.url as URL).href, 'http://localhost/');
});

test('prefixUrl alone does not set url', t => {
	const options = new Options({
		prefixUrl: 'https://example.com',
	});

	t.is(options.url, undefined);
});

test('maxRetryAfter is calculated separately from request timeout', t => {
	const options = new Options({
		timeout: {
			request: 1000,
		},
		retry: {
			maxRetryAfter: undefined,
		},
	});

	t.is(options.retry.maxRetryAfter, undefined);

	options.merge({
		timeout: {
			request: 2000,
		},
	});

	t.is(options.retry.maxRetryAfter, undefined);

	options.merge({
		retry: {
			maxRetryAfter: 300,
		},
	});

	t.is(options.retry.maxRetryAfter, 300);
});

test('extending responseType', t => {
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

	t.is(merged.defaults.options.responseType, 'json');
});

test('searchParams - multiple values for one key', t => {
	const searchParameters = new URLSearchParams();

	searchParameters.append('a', '100');
	searchParameters.append('a', '200');
	searchParameters.append('a', '300');

	const options = new Options({
		searchParams: searchParameters,
	});

	t.deepEqual(
		(options.searchParams as URLSearchParams).getAll('a'),
		['100', '200', '300'],
	);
});

test('searchParams - assigning a URLSearchParams clones it', t => {
	const searchParameters = new URLSearchParams('foo=bar');

	const options = new Options();
	options.searchParams = searchParameters;

	// Mutating the caller-owned object must not leak into the stored options.
	searchParameters.set('foo', 'changed');

	t.is(options.searchParams.toString(), 'foo=bar');
});

test('__proto__ in options does not cause prototype pollution', t => {
	const malicious = JSON.parse('{"method": "POST", "__proto__": {"injected": true}}');
	const options = new Options('https://example.com', malicious);

	t.is(Object.getPrototypeOf(options), Options.prototype);
	t.is(options.method, 'POST');
	t.is(typeof options.getInternalHeaders, 'function');
	t.is(({} as any).injected, undefined);
});

test('__proto__ in merge() does not cause prototype pollution', t => {
	const options = new Options('https://example.com');
	const malicious = JSON.parse('{"__proto__": {"injected": true}}');
	options.merge(malicious);

	t.is(Object.getPrototypeOf(options), Options.prototype);
	t.is(options.method, 'GET');
	t.is(typeof options.getInternalHeaders, 'function');
	t.is(({} as any).injected, undefined);
});

test('__proto__ in nested option objects does not cause prototype pollution', t => {
	const options = new Options('https://example.com');

	options.merge(JSON.parse('{"retry": {"__proto__": {"evil": true}}}'));
	t.is((options.retry as any).evil, undefined);

	options.merge(JSON.parse('{"timeout": {"__proto__": {"evil": true}}}'));
	t.is((options.timeout as any).evil, undefined);

	options.merge(JSON.parse('{"agent": {"__proto__": {"evil": true}}}'));
	t.is((options.agent as any).evil, undefined);

	options.merge(JSON.parse('{"https": {"__proto__": {"evil": true}}}'));
	t.is((options.https as any).evil, undefined);

	options.merge(JSON.parse('{"cacheOptions": {"__proto__": {"evil": true}}}'));
	t.is((options.cacheOptions as any).evil, undefined);

	options.merge(JSON.parse('{"context": {"__proto__": {"evil": true}}}'));
	t.is((options.context as any).evil, undefined);

	options.merge(JSON.parse('{"headers": {"__proto__": "leaked"}}'));
	t.false(Object.hasOwn(options.headers, '__proto__'));

	t.is(({} as any).evil, undefined);
});

test('__proto__ in searchParams does not cause prototype pollution', t => {
	const malicious = JSON.parse('{"searchParams": {"__proto__": {"evil": true}, "valid": "ok"}}');
	const options = new Options('https://example.com', malicious);

	t.is(({} as any).evil, undefined);
	const searchParameters = options.searchParams as URLSearchParams;
	t.is(searchParameters.get('valid'), 'ok');
	t.is(searchParameters.get('__proto__'), null);
});

if (globalThis.AbortSignal !== undefined) {
	test('signal does not get frozen', t => {
		const controller = new AbortController();
		const {signal} = controller;

		const options = new Options({
			url: new URL('http://localhost'),
			signal,
		});
		options.freeze();

		t.false(Object.isFrozen(options.signal));
	});
}

test('assigning a partial retry object keeps the other retry defaults', t => {
	const defaults = new Options().retry;
	const options = new Options();

	options.retry = {limit: 5};

	t.is(options.retry.limit, 5);
	t.deepEqual(options.retry.methods, defaults.methods);
	t.deepEqual(options.retry.statusCodes, defaults.statusCodes);
	t.deepEqual(options.retry.errorCodes, defaults.errorCodes);
	t.is(options.retry.noise, defaults.noise);
	t.is(options.retry.enforceRetryRules, defaults.enforceRetryRules);
});

test('assigning a partial pagination object keeps the other pagination defaults', t => {
	const defaults = new Options().pagination;
	const options = new Options();
	const paginate = (): false => false;

	options.pagination = {paginate};

	t.is(options.pagination.paginate, paginate);
	t.is(options.pagination.transform, defaults.transform);
	t.is(options.pagination.filter, defaults.filter);
	t.is(options.pagination.shouldContinue, defaults.shouldContinue);
	t.is(options.pagination.countLimit, defaults.countLimit);
	t.is(options.pagination.requestLimit, defaults.requestLimit);
	t.is(options.pagination.backoff, defaults.backoff);
	t.is(options.pagination.stackAllItems, defaults.stackAllItems);
});

test('changing prefixUrl throws when url no longer includes it', t => {
	const options = new Options('https://a.com/foo/bar', {});
	options.prefixUrl = 'https://a.com/foo/';
	options.url = 'https://b.com/other';

	t.throws(() => {
		options.prefixUrl = 'https://c.com/new/';
	}, {
		instanceOf: Error,
		message: 'The `url` option must include the `prefixUrl` option',
	});
});

test('changing prefixUrl preserves path when url includes it', t => {
	const options = new Options('other', {prefixUrl: 'https://a.com/foo/'});
	options.prefixUrl = 'https://c.com/new/';

	t.is((options.url as URL).href, 'https://c.com/new/other');
});

test('changing prefixUrl throws on same-origin path mismatch', t => {
	const options = new Options('https://a.com/other/path', {});
	options.prefixUrl = 'https://a.com/foo/';

	t.throws(() => {
		options.prefixUrl = 'https://c.com/new/';
	}, {
		instanceOf: Error,
		message: 'The `url` option must include the `prefixUrl` option',
	});
});

test('changing prefixUrl preserves query and hash', t => {
	const options = new Options('bar?x=1#s', {prefixUrl: 'https://a.com/foo/'});
	options.prefixUrl = 'https://c.com/new/';

	t.is((options.url as URL).href, 'https://c.com/new/bar?x=1#s');
});

test('replacing nested options does not remove supported option names', t => {
	const options = new Options();

	options.timeout = {request: 1000};
	options.timeout = {connect: 500};
	t.deepEqual(options.timeout, {connect: 500});

	options.agent = {http: false};
	options.agent = {https: false};
	t.deepEqual(options.agent, {https: false});

	options.https = {minVersion: 'TLSv1.2'};
	options.https = {maxVersion: 'TLSv1.3'};
	t.deepEqual(options.https, {maxVersion: 'TLSv1.3'});

	options.cacheOptions = {shared: false};
	options.cacheOptions = {cacheHeuristic: 0.5};
	t.deepEqual(options.cacheOptions, {cacheHeuristic: 0.5});
});

test('merging nested options after replacement accepts every supported key', t => {
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

	t.deepEqual(options.timeout, defaults.timeout);
	t.deepEqual(options.agent, defaults.agent);
	t.deepEqual(options.https, defaults.https);
	t.deepEqual(options.cacheOptions, defaults.cacheOptions);
});

test('replacing nested options still rejects unknown option names', t => {
	const options = new Options();
	options.timeout = {};
	options.agent = {};
	options.https = {};
	options.cacheOptions = {};

	for (const name of ['timeout', 'agent', 'https', 'cacheOptions'] as const) {
		t.throws(() => {
			// @ts-expect-error Testing unknown option names.
			options[name] = {unknown: true};
		}, {message: /Unexpected|does not exist/});
	}
});

test('cloning normalized options isolates URL mutations', t => {
	const original = new Options('https://example.com/items?page=1#original');
	const clone = new Options(undefined, undefined, original);

	(clone.url as URL).pathname = '/other';
	(clone.searchParams as URLSearchParams).set('page', '2');
	(clone.url as URL).hash = '#clone';

	t.is((original.url as URL).href, 'https://example.com/items?page=1#original');
	t.is((clone.url as URL).href, 'https://example.com/other?page=2#clone');
});

test('cloning options preserves query encoding without normalizing it', t => {
	const original = new Options('https://example.com/?query=a%20b&query=second');
	const clone = new Options(undefined, undefined, original);

	t.not(clone.url, original.url);
	t.is((clone.url as URL).search, '?query=a%20b&query=second');
	t.deepEqual((clone.searchParams as URLSearchParams).getAll('query'), ['a b', 'second']);
});

test('merging search parameters into a clone leaves the original URL intact', t => {
	const original = new Options('https://example.com/?page=1&keep=yes');
	const clone = new Options(undefined, {searchParams: {page: 2}}, original);

	t.is((clone.url as URL).search, '?keep=yes&page=2');
	t.is((original.url as URL).search, '?page=1&keep=yes');
});

test('assigning header arrays copies values while preserving header normalization', t => {
	const values = ['first', 'second'];
	const options = new Options();
	options.headers = {'X-Values': values, 'X-Single': 'value', 'X-Omitted': undefined};
	values.push('caller');

	t.deepEqual(options.headers['x-values'], ['first', 'second']);
	t.is(options.headers['x-single'], 'value');
	t.is(options.headers['x-omitted'], undefined);

	(options.headers['x-values'] as string[]).push('options');
	t.deepEqual(values, ['first', 'second', 'caller']);
});

test('merging header arrays does not retain caller or previous array values', t => {
	const options = new Options({headers: {'x-values': ['original']}});
	const values = ['replacement'];
	options.merge({headers: {'x-values': values}});
	values.push('caller');

	t.deepEqual(options.headers['x-values'], ['replacement']);
});

test('cloning options copies empty and populated header arrays', t => {
	const original = new Options({headers: {'x-empty': [], 'x-values': ['original']}});
	const clone = new Options(undefined, undefined, original);
	(clone.headers['x-empty'] as string[]).push('clone');
	(clone.headers['x-values'] as string[]).push('clone');

	t.deepEqual(original.headers['x-empty'], []);
	t.deepEqual(original.headers['x-values'], ['original']);
});

test('re-extending retains the header arrays captured from the original input', t => {
	const values = ['original'];
	const first = got.extend({headers: {'x-values': values}});
	values.push('caller');
	const second = got.extend(first);

	t.deepEqual(second.defaults.options.headers['x-values'], ['original']);
});

test('reading unset search parameters on frozen defaults does not throw', t => {
	const instance = got.extend();

	t.is((instance.defaults.options.searchParams as URLSearchParams).size, 0);
});

test('reading unset frozen search parameters does not create a query override', t => {
	const defaults = new Options();
	defaults.freeze();

	t.is((defaults.searchParams as URLSearchParams).size, 0);
	const options = new Options('https://example.com/?query=preserved', undefined, defaults);
	t.is((options.url as URL).search, '?query=preserved');
});

test('frozen defaults retain configured search parameters', t => {
	const instance = got.extend({searchParams: 'page=1&page=2'});
	const parameters = instance.defaults.options.searchParams as URLSearchParams;

	t.deepEqual(parameters.getAll('page'), ['1', '2']);
});

test('reading unset mutable search parameters still permits configuring defaults', t => {
	const defaults = new Options();
	(defaults.searchParams as URLSearchParams).set('page', '2');
	const options = new Options('https://example.com/', undefined, defaults);

	t.is((options.url as URL).search, '?page=2');
});

test('merging undefined search parameters clears the current normalized URL query', t => {
	const options = new Options('https://example.com/?page=1&page=2');
	options.merge({searchParams: undefined});

	t.is((options.url as URL).search, '');
});

test('immutable instance defaults prevent changing pagination settings', t => {
	const instance = got.extend({pagination: {countLimit: 10}});

	t.throws(() => {
		instance.defaults.options.pagination.countLimit = 0;
	}, {instanceOf: TypeError});
});

test('cloning frozen options produces independent mutable pagination settings', t => {
	const original = new Options({pagination: {countLimit: 10}});
	original.freeze();
	const clone = new Options(undefined, undefined, original);
	clone.pagination.countLimit = 1;

	t.is(original.pagination.countLimit, 10);
	t.is(clone.pagination.countLimit, 1);
});

test('native PFX options preserve raw entries mixed with object entries', t => {
	const bytes = new Uint8Array([1, 2, 3]);
	const options = new Options('https://example.com/', {https: {pfx: [{buffer: bytes}, bytes]}});

	t.deepEqual(options.createNativeRequestOptions().pfx, [{buf: bytes, passphrase: undefined}, bytes]);
});

test('native PFX options convert object entries after raw entries', t => {
	const bytes = new Uint8Array([1, 2, 3]);
	const object = {buffer: bytes, passphrase: 'synthetic'};
	const entries = ['synthetic', bytes, object];
	const options = new Options('https://example.com/', {https: {pfx: entries}});

	t.deepEqual(options.createNativeRequestOptions().pfx, ['synthetic', bytes, {buf: bytes, passphrase: 'synthetic'}]);
	t.deepEqual(options.https.pfx, entries);
	t.deepEqual(object, {buffer: bytes, passphrase: 'synthetic'});
});

test('native PFX options preserve homogeneous raw arrays and empty arrays', t => {
	for (const entries of [[], ['synthetic'], [new Uint8Array([1, 2, 3])]]) {
		const options = new Options('https://example.com/', {https: {pfx: entries}});

		t.deepEqual(options.createNativeRequestOptions().pfx, entries);
	}
});

test('native PFX options preserve per-entry passphrases', t => {
	const options = new Options('https://example.com/', {
		https: {
			passphrase: 'default',
			pfx: [{buffer: 'first'}, {buffer: 'second', passphrase: ''}, {buffer: 'third', passphrase: 'specific'}],
		},
	});
	const nativeOptions = options.createNativeRequestOptions();

	t.deepEqual(nativeOptions.pfx, [{buf: 'first', passphrase: undefined}, {buf: 'second', passphrase: ''}, {buf: 'third', passphrase: 'specific'}]);
	t.is(nativeOptions.passphrase, 'default');
});

test('standalone Uint8Array PFX options are accepted', t => {
	const bytes = new Uint8Array([1, 2, 3]);
	const options = new Options('https://example.com/', {https: {pfx: bytes}});

	t.is(options.createNativeRequestOptions().pfx, bytes);
});

test('standalone PFX byte arrays preserve subarray boundaries and empty values', t => {
	const bytes = new Uint8Array([0, 1, 2, 3]);

	for (const value of [bytes.subarray(1, 3), bytes.subarray(2, 2)]) {
		const options = new Options('https://example.com/', {https: {pfx: value}});

		t.is(options.createNativeRequestOptions().pfx, value);
	}
});

test('standalone PFX still accepts Buffer and string values', t => {
	for (const value of [Buffer.alloc(3, 1), 'synthetic']) {
		const options = new Options('https://example.com/', {https: {pfx: value}});

		t.is(options.createNativeRequestOptions().pfx, value);
	}
});

test('standalone PFX rejects non-byte typed arrays', t => {
	const options = new Options();

	t.throws(() => {
		// @ts-expect-error PFX accepts byte arrays, not arbitrary typed arrays.
		options.https = {pfx: new Uint16Array([1, 2])};
	}, {message: /Option 'https\.pfx'/});
});

test('undefined retry methods preserve inherited methods', t => {
	const options = new Options({retry: {methods: ['POST']}});
	options.merge({retry: {methods: undefined}});

	t.deepEqual(options.retry.methods, ['POST']);
});

for (const merge of [false, true]) {
	test(`undefined retry settings preserve required values with merge ${merge}`, t => {
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

		t.deepEqual(options.retry, {...original, maxRetryAfter: undefined});
	});
}

test('explicit retry values can still clear arrays and disable retry settings', t => {
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

	t.deepEqual(options.retry, retry);
});

test('immutable default header arrays reject mutation', t => {
	const instance = got.extend({headers: {'x-values': ['first']}});

	t.throws(() => {
		(instance.defaults.options.headers['x-values'] as string[]).push('second');
	}, {instanceOf: TypeError});
});

test('freezing headers handles empty arrays and scalar values', t => {
	const options = new Options({headers: {'x-empty': [], 'x-single': 'value', 'x-omitted': undefined}});
	options.freeze();

	t.throws(() => {
		(options.headers['x-empty'] as string[]).push('value');
	}, {instanceOf: TypeError});
	t.is(options.headers['x-single'], 'value');
	t.is(options.headers['x-omitted'], undefined);
});

test('custom method names normalize request and retry methods', t => {
	// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- Verify callers can supply a general string.
	const method: string = 'propfind';
	const options = new Options({method, retry: {methods: [method, 'PROPFIND', 'REPORT']}});

	t.is(options.method, 'PROPFIND');
	t.deepEqual(options.retry.methods, ['PROPFIND', 'REPORT']);
});

test('custom method support still rejects non-string values', t => {
	t.throws(() => new Options({
		// @ts-expect-error Methods must be strings.
		method: 123,
	}), {instanceOf: TypeError});
});
