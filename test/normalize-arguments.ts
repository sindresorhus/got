import {Agent} from 'node:http';
import {Buffer} from 'node:buffer';
import assert from 'node:assert/strict';
import {expectTypeOf} from 'expect-type';
import ResponseLike from 'responselike';
import got, {Options, type NormalizedOptions} from '../source/index.js';
import {errorMatching} from './helpers/error-matching.js';
import test from './helpers/test.js';

test('changing to a Unix prefix retains the current URL fragment', _t => {
	const options = new Options('child?x=1#section', {enableUnixSockets: true, prefixUrl: 'https://example.com/base/'});
	options.prefixUrl = 'unix:/tmp/a.sock:/api/';
	assert.strictEqual(options.url?.toString(), 'http://unix/tmp/a.sock:/api/child?x=1#section');
});

for (const inherited of [false, true]) {
	test(`option snapshots retain ${inherited ? 'inherited' : 'non-enumerable'} nested retry arrays`, _t => {
		let reads = 0;
		const source = Object.defineProperty({}, 'statusCodes', {
			get() {
				reads++;
				return [429];
			},
		});
		const options = new Options({retry: inherited ? Object.create(source) : source});
		assert.deepStrictEqual(options.retry.statusCodes, [429]);
		assert.strictEqual(reads, 1);
	});

	test(`option snapshots retain ${inherited ? 'inherited' : 'non-enumerable'} nested hook arrays`, _t => {
		let reads = 0;
		const hook = () => {};
		const source = Object.defineProperty({}, 'beforeRequest', {
			get() {
				reads++;
				return [hook];
			},
		});
		const options = new Options({hooks: inherited ? Object.create(source) : source});
		assert.deepStrictEqual(options.hooks.beforeRequest, [hook]);
		assert.strictEqual(reads, 1);
	});
}

for (const [name, value] of [
	['headers', {'x-value': 'first'}],
	['timeout', {request: 100}],
	['context', {token: 'first'}],
	['retry', {limit: 1}],
	['https', {rejectUnauthorized: true}],
	['searchParams', {token: 'first'}],
	['hooks', {beforeRequest: []}],
	['agent', {http: undefined}],
	['cacheOptions', {cacheHeuristic: 0.1}],
	['pagination', {backoff: 10}],
] as const) {
	for (const enumerable of [false, true]) {
		test(`option snapshots evaluate the ${enumerable ? 'enumerable' : 'non-enumerable'} ${name} getter once`, _t => {
			let calls = 0;
			const input = Object.defineProperty({}, name, {
				enumerable,
				get() {
					calls++;
					return value;
				},
			});
			assert.doesNotThrow(() => new Options(input));
			assert.strictEqual(calls, 1);
		});
	}
}

test('retry snapshots evaluate nested array getters once and keep their first values', _t => {
	let calls = 0;
	const options = new Options({
		retry: {
			get statusCodes() {
				calls++;
				return [calls === 1 ? 429 : 503];
			},
		},
	});
	assert.strictEqual(calls, 1);
	assert.deepStrictEqual(options.retry.statusCodes, [429]);
});

test('hook snapshots capture nested getter values before cloning their arrays', _t => {
	let calls = 0;
	const hook = () => {};
	const handlers = [hook];
	const options = new Options({
		hooks: {
			get beforeRequest() {
				calls++;
				return handlers;
			},
		},
	});
	handlers.length = 0;
	assert.strictEqual(calls, 1);
	assert.deepStrictEqual(options.hooks.beforeRequest, [hook]);
});

for (const headers of [undefined, {'x-value': 'first'}]) {
	test(`an options getter that can only be read once retains ${headers === undefined ? 'absence' : 'its first value'}`, _t => {
		let calls = 0;
		const options = new Options({
			get headers() {
				if (++calls > 1) {
					throw new Error('Options getter was read again');
				}

				return headers;
			},
		});
		assert.strictEqual(calls, 1);
		assert.strictEqual(options.headers['x-value'], headers?.['x-value']);
	});
}

for (const searchParameters of ['', undefined]) {
	test(`non-enumerable empty search parameters keep the inherited query for ${String(searchParameters)}`, _t => {
		const defaults = new Options({searchParams: {keep: 'yes'}});
		let calls = 0;
		const input = Object.defineProperty({}, 'searchParams', {
			get() {
				calls++;
				return searchParameters;
			},
		});
		const options = new Options(input, undefined, defaults);
		assert.strictEqual(calls, 1);
		assert.strictEqual(options.searchParams.toString(), 'keep=yes');
	});
}

test('Unix prefix changes use the normalized HTTP socket URL', _t => {
	const options = new Options('child?x=1', {enableUnixSockets: true, prefixUrl: 'unix:/tmp/old.sock:/api/'});
	options.prefixUrl = 'unix:/tmp/new.sock:/other/';
	assert.strictEqual(options.url?.toString(), 'http://unix/tmp/new.sock:/other/child?x=1');
});

for (const [prefixUrl, nextPrefixUrl] of [
	['unix:/tmp/old.sock:/api/', 'http://unix/tmp/new.sock:/other/'],
	['http://unix/tmp/old.sock:/api/', 'unix:/tmp/new.sock:/other/'],
	[' \tunix:/tmp/old.sock:/api/', ' \tunix:/tmp/new.sock:/other/'],
]) {
	test(`Unix prefix normalization preserves transport targets when changing ${JSON.stringify(prefixUrl)}`, _t => {
		const options = new Options('child?keep=yes', {enableUnixSockets: true, prefixUrl});
		const previousUrl = options.url;
		options.prefixUrl = nextPrefixUrl!;
		assert.strictEqual(options.url, previousUrl);
		assert.strictEqual(options.url?.toString(), 'http://unix/tmp/new.sock:/other/child?keep=yes');
		const native = options.createNativeRequestOptions();
		assert.strictEqual(native.socketPath, '/tmp/new.sock');
		assert.strictEqual(native.path, '/other/child?keep=yes');
	});
}

test('a Unix prefix can change to an ordinary URL and retain encoded socket path bytes', _t => {
	const prefixUrl = new URL('unix:/tmp/with%20space.sock:/base/');
	const options = new Options('child?keep=yes', {enableUnixSockets: true, prefixUrl});
	options.prefixUrl = 'unix:/tmp/new%20space.sock:/changed/';
	assert.strictEqual(options.createNativeRequestOptions().socketPath, '/tmp/new space.sock');
	options.prefixUrl = 'https://example.com/api/';
	assert.strictEqual(options.url?.toString(), 'https://example.com/api/child?keep=yes');
	assert.strictEqual(options.createNativeRequestOptions().socketPath, undefined);
	assert.strictEqual(prefixUrl.href, 'unix:/tmp/with%20space.sock:/base/');
});

for (const prefixUrl of ['unix:/tmp/example.sock:/api?', 'unix:/tmp/example.sock:/api#']) {
	test(`Unix prefixes reject path-swallowing delimiters in ${prefixUrl}`, _t => {
		assert.throws(() => new Options({prefixUrl}), {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
		const options = new Options('child', {enableUnixSockets: true, prefixUrl: 'unix:/tmp/old.sock:/base/'});
		assert.throws(() => {
			options.prefixUrl = prefixUrl;
		}, {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
		assert.strictEqual(options.prefixUrl, 'unix:/tmp/old.sock:/base/');
		assert.strictEqual(options.url?.toString(), 'http://unix/tmp/old.sock:/base/child');
	});
}

for (const prefixUrl of [' https://example.com/base/', 'ht\ttps://example.com/base/', '\u{1}https://example.com/base/']) {
	test(`prefix changes use URL parser normalization for ${JSON.stringify(prefixUrl)}`, _t => {
		const options = new Options('child?x=1', {prefixUrl});
		options.prefixUrl = 'https://other.example/new/';
		assert.strictEqual(options.url?.toString(), 'https://other.example/new/child?x=1');
	});
}

for (const prefixUrl of [' https://example.com/base?', 'ht\ttps://example.com/base#']) {
	test(`normalized prefix URLs reject path-swallowing delimiters in ${JSON.stringify(prefixUrl)}`, _t => {
		assert.throws(() => new Options({prefixUrl}), {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
		assert.throws(() => new Options('child', {prefixUrl}), {message: 'Invalid URL'});
		const options = new Options('child?keep=yes', {prefixUrl: 'https://user:secret@example.com/base/'});
		const previousUrl = options.url;
		assert.throws(() => {
			options.prefixUrl = prefixUrl;
		}, {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
		assert.strictEqual(options.prefixUrl, 'https://user:secret@example.com/base/');
		assert.strictEqual(options.url, previousUrl);
		assert.strictEqual(options.url?.toString(), 'https://user:secret@example.com/base/child?keep=yes');
	});
}

test('normalized prefix credentials replace earlier credentials on the same origin', _t => {
	const options = new Options('child', {prefixUrl: 'https://old:secret@example.com/base/'});
	options.prefixUrl = ' \thttps://new@example.com/new/';
	assert.strictEqual(options.username, 'new');
	assert.strictEqual(options.password, '');
	assert.strictEqual(options.url?.toString(), 'https://new@example.com/new/child');
});

for (const prefixUrl of [' https://EXAMPLE.com:443/base/../folder/', 'ht\ttps://user%3F:pass%23@example.com/a%3Fb%23c/', ' https://example.com/with space /']) {
	test(`normalized prefix changes preserve URL semantics for ${JSON.stringify(prefixUrl)}`, _t => {
		const options = new Options('child?keep=yes', {prefixUrl});
		const expected = new URL(`${prefixUrl}child?keep=yes`);
		assert.strictEqual(options.url?.toString(), expected.href);
		options.prefixUrl = 'https://other.example/changed/';
		assert.strictEqual(options.url?.toString(), 'https://other.example/changed/child?keep=yes');
		assert.strictEqual(options.username, '');
		assert.strictEqual(options.password, '');
	});
}

for (const input of [' https://other.example/path?x=1#section', '\thttps://other.example/path', 'ht\ttps://other.example/path', '\r\nhttps://other.example/path', '\u{1}https://other.example/path', 'ht\nt\rps://other.example/path']) {
	test(`absolute URL classification matches URL parsing for ${JSON.stringify(input)}`, _t => {
		const options = new Options(input, {prefixUrl: 'https://base.example/root/'});
		assert.strictEqual(options.url?.toString(), new URL(input).href);
		assert.throws(() => new Options(input, {prefixUrl: 'https://base.example/root/', allowAbsoluteUrls: false}), {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'});
	});
}

for (const [input, path] of [
	[' child', '%20child'],
	['\u{1}child', '%01child'],
	['%09https://other.example/path', '%09https://other.example/path'],
	['%20https://other.example/path', '%20https://other.example/path'],
	['ht%09tps://other.example/path', 'ht%09tps://other.example/path'],
	['folder/\thttps://other.example/path', 'folder/https://other.example/path'],
]) {
	test(`absolute URL classification preserves relative input bytes for ${JSON.stringify(input)}`, _t => {
		for (const allowAbsoluteUrls of [false, true]) {
			const options = new Options(input, {prefixUrl: 'https://base.example/root/', allowAbsoluteUrls});
			assert.strictEqual(options.url?.toString(), `https://base.example/root/${path}`);
		}
	});
}

test('absolute URL classification does not give scheme-relative input a base', _t => {
	assert.throws(() => new Options('//other.example/path', {prefixUrl: 'https://base.example/root/'}), {message: '`url` must not start with a slash'});
	assert.throws(() => new Options(' \t//other.example/path', {prefixUrl: 'https://base.example/root/'}), {message: 'Invalid URL'});
	assert.throws(() => new Options(' \t//other.example/path', {prefixUrl: 'https://base.example/root/', allowAbsoluteUrls: false}), {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'});
});

test('absolute URL classification applies to assignment and preserves a rejected URL', _t => {
	const options = new Options('initial', {prefixUrl: 'https://base.example/root/'});
	options.url = ' \thttps://other.example/accepted';
	assert.strictEqual(options.toJSON().url?.toString(), 'https://other.example/accepted');
	options.allowAbsoluteUrls = false;

	assert.throws(() => {
		options.url = 'ht\ntps://third.example/rejected';
	}, {message: 'The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set'});
	assert.strictEqual(options.toJSON().url?.toString(), 'https://other.example/accepted');
});

for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://2130706433/', 'https://unix/tmp/got.sock:/path']) {
	test(`HTTP/2 does not use a DNS timeout for ${url}`, _t => {
		const options = new Options(url, {
			http2: true,
			enableUnixSockets: true,
			timeout: {lookup: 1, connect: 100},
		});
		const native = options.createNativeRequestOptions();

		assert.strictEqual(native.timeout, 100);
		assert.strictEqual(Reflect.get(native, '_timeoutPhase'), 'connect');
	});

	test(`HTTP/2 lookup-only timeout leaves no handshake budget for ${url}`, _t => {
		const options = new Options(url, {http2: true, enableUnixSockets: true, timeout: {lookup: 1}});
		const native = options.createNativeRequestOptions();

		assert.strictEqual(native.timeout, undefined);
		assert.strictEqual(Object.hasOwn(native, '_timeoutPhase'), false);
	});
}

test('HTTP/2 keeps the lookup budget for a hostname', _t => {
	const options = new Options('https://lookup.example/', {http2: true, timeout: {lookup: 1, connect: 100}});
	const native = options.createNativeRequestOptions();

	assert.strictEqual(native.timeout, 1);
	assert.strictEqual(Reflect.get(native, '_timeoutPhase'), 'lookup');
});

for (const [phase, timeout] of [['secureConnect', 10], ['request', 0]] as const) {
	test(`HTTP/2 keeps the ${phase} minimum when DNS does not apply`, _t => {
		const options = new Options('https://127.0.0.1/', {http2: true, timeout: {lookup: 1, connect: 100, [phase]: timeout}});
		const native = options.createNativeRequestOptions();

		assert.strictEqual(native.timeout, timeout);
		assert.strictEqual(Reflect.get(native, '_timeoutPhase'), phase);
	});
}

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

	const searchParameters = options.searchParams;

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

	assert.strictEqual(options.url!.href, 'http://localhost/?foo=');
});

test('undefined value in search params means it does not exist', _t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: undefined,
		},
	});

	assert.strictEqual(options.url!.href, 'http://localhost/');
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
		(options.searchParams).getAll('a'),
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
	const searchParameters = options.searchParams;
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

	assert.strictEqual(options.url!.href, 'https://c.com/new/other');
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

	assert.strictEqual(options.url!.href, 'https://c.com/new/bar?x=1#s');
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

	clone.url!.pathname = '/other';
	(clone.searchParams).set('page', '2');
	clone.url!.hash = '#clone';

	assert.strictEqual(original.url!.href, 'https://example.com/items?page=1#original');
	assert.strictEqual(clone.url!.href, 'https://example.com/other?page=2#clone');
});

test('cloning options preserves query encoding without normalizing it', _t => {
	const original = new Options('https://example.com/?query=a%20b&query=second');
	const clone = new Options(undefined, undefined, original);

	assert.notStrictEqual(clone.url, original.url);
	assert.strictEqual(clone.url!.search, '?query=a%20b&query=second');
	assert.deepStrictEqual((clone.searchParams).getAll('query'), ['a b', 'second']);
});

test('merging search parameters into a clone leaves the original URL intact', _t => {
	const original = new Options('https://example.com/?page=1&keep=yes');
	const clone = new Options(undefined, {searchParams: {page: 2}}, original);

	assert.strictEqual(clone.url!.search, '?keep=yes&page=2');
	assert.strictEqual(original.url!.search, '?page=1&keep=yes');
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

	assert.strictEqual((instance.defaults.options.searchParams).size, 0);
});

test('reading unset frozen search parameters does not create a query override', _t => {
	const defaults = new Options();
	defaults.freeze();

	assert.strictEqual((defaults.searchParams).size, 0);
	const options = new Options('https://example.com/?query=preserved', undefined, defaults);
	assert.strictEqual(options.url!.search, '?query=preserved');
});

// A frozen instance hands out a copy, so a write to what it returns cannot reach its state.
test('a write through the frozen searchParams getter is discarded', _t => {
	const defaults = new Options(undefined, {searchParams: {token: 'abc'}});
	defaults.freeze();
	const read = (): URLSearchParams => defaults.searchParams;

	assert.strictEqual(read().get('token'), 'abc');
	assert.notStrictEqual(read(), read());

	read().set('leaked', 'yes');

	assert.strictEqual(read().get('leaked'), null);
	assert.strictEqual(read().size, 1);
});

test('frozen defaults retain configured search parameters', _t => {
	const instance = got.extend({searchParams: 'page=1&page=2'});
	const parameters = instance.defaults.options.searchParams;

	assert.deepStrictEqual(parameters.getAll('page'), ['1', '2']);
});

test('reading unset mutable search parameters still permits configuring defaults', _t => {
	const defaults = new Options();
	(defaults.searchParams).set('page', '2');
	const options = new Options('https://example.com/', undefined, defaults);

	assert.strictEqual(options.url!.search, '?page=2');
});

test('merging undefined search parameters clears the current normalized URL query', _t => {
	const options = new Options('https://example.com/?page=1&page=2');
	options.merge({searchParams: undefined});

	assert.strictEqual(options.url!.search, '');
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
for (const prefix of ['https://example.com/?', 'https://example.com/#', 'https://example.com/base?', 'https://example.com/base#']) {
	for (const asUrl of [false, true]) {
		test(`rejects empty query or fragment delimiters in prefixUrl ${prefix}, URL=${asUrl}`, _t => {
			const options = new Options('http://example.com/');
			const prefixUrl = asUrl ? new URL(prefix) : prefix;

			assert.throws(() => {
				options.prefixUrl = prefixUrl;
			}, {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
			assert.strictEqual(options.prefixUrl, '');
			assert.strictEqual(options.url?.toString(), 'http://example.com/');
			assert.throws(() => new Options({prefixUrl}), {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
			assert.throws(() => new Options(undefined, {prefixUrl}), {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
		});
	}
}

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

for (const prefixUrl of ['https://example.com', 'https://example.com/', 'https://example.com/a/b', 'https://example.com/a%20b', 'https://example.com/a%3Fb%23c', 'https://user%3F:pass%23@example.com/base']) {
	test(`accepts a prefixUrl of ${JSON.stringify(prefixUrl)}`, _t => {
		assert.strictEqual(new Options('foo', {prefixUrl}).url?.toString(), `${prefixUrl.replace(/\/$/v, '')}/foo`);
	});
}

test('rejecting a prefixUrl delimiter preserves the current prefix and URL', _t => {
	const options = new Options('child', {prefixUrl: 'https://example.com/base/'});

	assert.throws(() => {
		options.prefixUrl = 'https://other.example/new#';
	}, {message: 'The `prefixUrl` option must not contain a query string or a fragment'});
	assert.strictEqual(options.prefixUrl, 'https://example.com/base/');
	assert.strictEqual(options.url?.toString(), 'https://example.com/base/child');
});

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
	(options.searchParams).set('c', '3');
	assert.strictEqual((options.searchParams).toString(), 'a=1&b=2');
	assert.strictEqual(String(options.url), 'http://example.com/?a=1&b=2');
});

for (const credential of ['username', 'password'] as const) {
	test(`a frozen instance rejects ${credential} changes without changing its URL`, _t => {
		const options = new Options('https://user:secret@example.com/base/path');
		options.freeze();

		assert.throws(() => {
			options[credential] = 'changed';
		}, TypeError);
		assert.strictEqual(options.url?.toString(), 'https://user:secret@example.com/base/path');
	});
}

test('a failed prefix change on frozen options leaves its URL unchanged', _t => {
	const options = new Options('path', {prefixUrl: 'https://example.com/base/'});
	options.freeze();

	assert.throws(() => {
		options.prefixUrl = 'https://other.example/new/';
	}, TypeError);
	assert.strictEqual(options.prefixUrl, 'https://example.com/base/');
	assert.strictEqual(options.url?.toString(), 'https://example.com/base/path');
});

test('the URL returned by frozen options cannot rewrite its stored URL', _t => {
	const options = new Options('https://user:secret@example.com/base/path?keep=yes');
	options.freeze();
	const exposed = options.url!;
	exposed.href = 'https://other.example/changed';

	assert.strictEqual(options.url?.toString(), 'https://user:secret@example.com/base/path?keep=yes');
	assert.strictEqual(options.username, 'user');
	assert.strictEqual(options.password, 'secret');
});

test('freezing detaches an earlier URL alias and remains safe to repeat', _t => {
	const options = new Options('https://user:secret@example.com/base/path?keep=yes');
	const exposed = options.url!;
	options.freeze();
	exposed.href = 'https://other.example/changed';

	assert.doesNotThrow(() => {
		options.freeze();
	});
	assert.strictEqual(options.url?.toString(), 'https://user:secret@example.com/base/path?keep=yes');
	assert.strictEqual(options.username, 'user');
	assert.strictEqual(options.password, 'secret');

	const clone = new Options(undefined, undefined, options);
	const clonedUrl = clone.url!;
	clonedUrl.searchParams.set('changed', 'yes');
	clone.username = 'clone';
	assert.strictEqual(clone.url, clonedUrl);
	assert.strictEqual(clone.username, 'clone');
	assert.strictEqual(clone.searchParams.get('changed'), 'yes');
	assert.strictEqual(options.searchParams.has('changed'), false);
});

test('mutable URL, credential, and prefix updates retain the same live URL', _t => {
	const options = new Options('path?keep=yes#section', {prefixUrl: 'https://example.com/base/'});
	const url = options.url!;
	url.searchParams.set('direct', 'allowed');
	options.username = 'user name';
	options.password = 'secret?';
	options.prefixUrl = 'https://example.com/new/';

	assert.strictEqual(options.url, url);
	assert.strictEqual(url.href, 'https://user%20name:secret%3F@example.com/new/path?keep=yes&direct=allowed#section');
	assert.strictEqual(options.username, 'user name');
	assert.strictEqual(options.password, 'secret?');
});

test('frozen options without a URL still return an absent URL', _t => {
	const options = new Options();
	options.freeze();

	assert.strictEqual(options.url, undefined);
	assert.doesNotThrow(() => {
		options.freeze();
	});
});

test('freezing detaches search parameters read before a URL was assigned', _t => {
	const options = new Options({searchParams: {keep: 'original'}});
	const exposed = options.searchParams;
	options.freeze();
	exposed.set('keep', 'changed');
	exposed.set('added', 'unexpected');

	assert.deepStrictEqual([...options.searchParams], [['keep', 'original']]);
	const clone = new Options('https://example.com/', undefined, options);
	assert.strictEqual(clone.url!.search, '?keep=original');
});

// Each setter validates its own type, so a wrong value is reported instead of reaching the request, and the option keeps its previous value.
for (const [name, validValue, invalidValue] of [
	['decompress', false, 'false'],
	['ignoreInvalidCookies', true, 1],
	['throwHttpErrors', false, 0],
	['http2', true, 'yes'],
	['allowGetBody', true, 'yes'],
	['allowAbsoluteUrls', false, 'no'],
	['copyPipedHeaders', false, 0],
	['methodRewriting', true, 1],
	['resolveBodyOnly', true, 'true'],
	['setHost', false, 'false'],
	['enableUnixSockets', true, 1],
	['strictContentLength', false, 'false'],
	['followRedirect', false, 'false'],
	['username', 'user', 1],
	['password', 'secret', 1],
	['localAddress', '127.0.0.1', 1],
	['maxHeaderSize', 1024, '1024'],
	['encoding', 'latin1', 1],
	['parseJson', (text: string) => JSON.parse(text) as unknown, 'JSON.parse'],
	['stringifyJson', (value: unknown) => JSON.stringify(value), 'JSON.stringify'],
	['dnsLookup', () => {}, 'lookup'],
	['request', () => {}, 'request'],
	['createConnection', () => {}, 'connect'],
	['context', {a: 1}, 'context'],
	['signal', new AbortController().signal, 'signal'],
] as Array<[string, unknown, unknown]>) {
	test(`the ${name} option rejects ${JSON.stringify(invalidValue)} and keeps its previous value`, _t => {
		const options = new Options({[name]: validValue});
		const previousValue = Reflect.get(options, name) as unknown;

		assert.throws(() => {
			Reflect.set(options, name, invalidValue);
		}, TypeError);
		assert.throws(() => new Options({[name]: invalidValue}), TypeError);
		assert.deepStrictEqual(Reflect.get(options, name), previousValue);
	});
}

test('a DNS lookup IP version other than 4 or 6 is rejected', _t => {
	for (const version of [4, 6, undefined] as const) {
		assert.strictEqual(new Options({dnsLookupIpVersion: version}).dnsLookupIpVersion, version);
	}

	const options = new Options({dnsLookupIpVersion: 6});

	for (const version of [0, 5, '4']) {
		assert.throws(() => {
			options.dnsLookupIpVersion = version as never;
		}, errorMatching(TypeError, {message: `Invalid DNS lookup IP version: ${version}`}));
	}

	assert.strictEqual(options.dnsLookupIpVersion, 6);
});

test('an Options instance is only accepted as the defaults argument', _t => {
	const defaults = new Options({headers: {token: 'default'}});

	for (const create of [
		() => new Options(defaults),
		() => new Options('http://example.com/', defaults),
	]) {
		assert.throws(create, errorMatching(TypeError, {message: 'The defaults must be passed as the third argument'}));
	}

	assert.strictEqual(new Options('http://example.com/', undefined, defaults).headers.token, 'default');
});

test('merging headers replaces an existing header whatever its case', _t => {
	const options = new Options({headers: {'X-Token': 'first', accept: 'text/plain'}});
	options.merge({headers: {'x-token': 'second'}});
	options.merge({headers: {'X-TOKEN': 'third'}});

	assert.strictEqual(options.headers['x-token'], 'third');
	assert.strictEqual(options.headers['X-Token'], 'third');
	assert.strictEqual(options.headers.accept, 'text/plain');
	assert.deepStrictEqual(Object.keys(options.headers).filter(name => name.toLowerCase() === 'x-token'), ['x-token']);
});
