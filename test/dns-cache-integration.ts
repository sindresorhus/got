import assert from 'node:assert/strict';
import http from 'node:http';
import type {LookupFunction} from 'node:net';
import DnsCache from '../source/core/utils/dns-cache.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

const createLookup = (address = '127.0.0.1', family = 4): LookupFunction => ((_hostname: string, options: any, callback: any) => {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}

	if (options.all) {
		callback(null, [{address, family}]);
		return;
	}

	callback(null, address, family);
}) as LookupFunction;

test('Got uses internal DNS cache lookup option', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: {
			resolve4(_hostname, options) {
				assert.deepEqual(options, {ttl: true});
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
			resolve6() {
				return [];
			},
		},
	});
	const instance = got.extend({
		dnsCache: cache,
		agent: {
			http: new http.Agent({
				keepAlive: false,
			}),
		},
	});

	assert.strictEqual((await instance('')).body, 'ok');
	assert.strictEqual((await instance('')).body, 'ok');
	assert.strictEqual(resolve4CallCount, 1);
});

test('Got uses shared DNS cache when dnsCache is true', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let lookupOptionCount = 0;
	let sharedLookup: LookupFunction | undefined;
	// This tests cache selection; localhost DNS records depend on the machine's resolver.
	const url = new URL(server.url);
	url.hostname = '127.0.0.1';
	const instance = got.extend({
		prefixUrl: url,
		dnsCache: true,
		agent: {
			http: new http.Agent({
				keepAlive: false,
			}),
		},
		hooks: {
			beforeRequest: [
				options => {
					const {lookup} = options.createNativeRequestOptions();
					sharedLookup ??= lookup;
					assert.strictEqual(options.dnsCache instanceof DnsCache, true);
					assert.strictEqual(typeof lookup, 'function');
					assert.strictEqual(lookup, sharedLookup);
					lookupOptionCount++;
				},
			],
		},
	});

	assert.strictEqual((await instance('')).body, 'ok');
	assert.strictEqual((await instance.extend({dnsCache: true})('')).body, 'ok');
	assert.strictEqual(lookupOptionCount, 2);
});

test('custom DNS cache object can be used with Got', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let lookupCallCount = 0;
	const instance = got.extend({
		dnsCache: {
			lookup: ((hostname: string, options: any, callback: any) => {
				lookupCallCount++;
				createLookup('127.0.0.1', 4)(hostname, options, callback);
			}) as LookupFunction,
		},
	});

	assert.strictEqual((await instance('')).body, 'ok');
	assert.strictEqual(lookupCallCount, 1);
});

test('custom DNS cache lookup methods retain their receiver', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = {
		address: '127.0.0.1',
		lookup(this: {address: string}, _hostname: string, _options: unknown, callback: Parameters<LookupFunction>[2]) {
			callback(null, this.address, 4);
		},
	};

	assert.strictEqual(await got('', {dnsCache: cache, dnsLookupIpVersion: 4, retry: {limit: 0}}).text(), 'ok');
});

test('custom DNS cache lookup wrappers observe replaced methods and keep their identity', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let initialLookupCount = 0;
	let replacementLookupCount = 0;
	const cache = {
		address: '127.0.0.1',
		lookup(this: {address: string}, _hostname: string, _options: unknown, callback: Parameters<LookupFunction>[2]) {
			initialLookupCount++;
			callback(null, this.address, 4);
		},
	};
	const lookups: Array<LookupFunction | undefined> = [];
	const instance = got.extend({
		dnsCache: cache,
		dnsLookupIpVersion: 4,
		retry: {limit: 0},
		agent: {http: new http.Agent({keepAlive: false})},
		hooks: {
			beforeRequest: [options => {
				lookups.push(options.createNativeRequestOptions().lookup);
			}],
		},
	});

	assert.strictEqual(await instance('').text(), 'ok');
	cache.lookup = function (_hostname, _options, callback) {
		replacementLookupCount++;
		callback(null, this.address, 4);
	};

	assert.strictEqual(await instance('').text(), 'ok');
	assert.strictEqual(initialLookupCount, 1);
	assert.strictEqual(replacementLookupCount, 1);
	assert.strictEqual(lookups.length, 2);
	assert.strictEqual(lookups[0], lookups[1]);
});

test('custom DNS cache objects can be frozen', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = Object.freeze({
		address: '127.0.0.1',
		lookup(this: {address: string}, _hostname: string, _options: unknown, callback: Parameters<LookupFunction>[2]) {
			callback(null, this.address, 4);
		},
	});

	assert.strictEqual(await got('', {dnsCache: cache, dnsLookupIpVersion: 4, retry: {limit: 0}}).text(), 'ok');
});

test('explicit DNS lookup takes precedence over a custom cache', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let lookupCalls = 0;
	const lookup = createLookup();
	const text = await got('', {
		dnsLookup(hostname, options, callback) {
			lookupCalls++;
			lookup(hostname, options, callback);
		},
		dnsCache: {
			lookup() {
				assert.fail('The cache must not be used when dnsLookup is provided');
			},
		},
		retry: {
			limit: 0,
		},
	}).text();

	assert.strictEqual(text, 'ok');
	assert.strictEqual(lookupCalls, 1);
});

// Node asks a lookup for every address when it selects a family itself, so a lookup written
// against the documented single-result shape must still work.
for (const [name, lookup] of [
	['a single-result lookup', (_hostname: string, _options: unknown, callback: (error: Error | undefined, address: string, family: number) => void) => {
		callback(undefined, '127.0.0.1', 4);
	}],
	['a lookup that answers with a list', (_hostname: string, _options: unknown, callback: (error: Error | undefined, addresses: Array<{address: string; family: number}>) => void) => {
		callback(undefined, [{address: '127.0.0.1', family: 4}]);
	}],
] as Array<[string, LookupFunction]>) {
	test(`a custom dnsLookup works with ${name}`, withServer, async (_t, server, got) => {
		server.get('/', (_request, response) => {
			response.end('ok');
		});

		const response = await got('', {
			dnsLookup: lookup,
			retry: {
				limit: 0,
			},
		});

		assert.strictEqual(response.statusCode, 200);
	});
}
