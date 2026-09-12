import assert from 'node:assert/strict';
import http from 'node:http';
import type {LookupFunction} from 'node:net';
import test from 'ava';
import DnsCache from '../source/core/utils/dns-cache.js';
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

test('Got uses internal DNS cache lookup option', withServer, async (t, server, got) => {
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

	t.is((await instance('')).body, 'ok');
	t.is((await instance('')).body, 'ok');
	t.is(resolve4CallCount, 1);
});

test('Got uses shared DNS cache when dnsCache is true', withServer, async (t, server, got) => {
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
					t.true(options.dnsCache instanceof DnsCache);
					t.is(typeof lookup, 'function');
					t.is(lookup, sharedLookup);
					lookupOptionCount++;
				},
			],
		},
	});

	t.is((await instance('')).body, 'ok');
	t.is((await instance.extend({dnsCache: true})('')).body, 'ok');
	t.is(lookupOptionCount, 2);
});

test('custom DNS cache object can be used with Got', withServer, async (t, server, got) => {
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

	t.is((await instance('')).body, 'ok');
	t.is(lookupCallCount, 1);
});

test('custom DNS cache lookup methods retain their receiver', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = {
		address: '127.0.0.1',
		lookup(this: {address: string}, _hostname: string, _options: unknown, callback: Parameters<LookupFunction>[2]) {
			callback(null, this.address, 4);
		},
	};

	t.is(await got('', {dnsCache: cache, dnsLookupIpVersion: 4, retry: {limit: 0}}).text(), 'ok');
});

test('custom DNS cache lookup wrappers observe replaced methods and keep their identity', withServer, async (t, server, got) => {
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

	t.is(await instance('').text(), 'ok');
	cache.lookup = function (_hostname, _options, callback) {
		replacementLookupCount++;
		callback(null, this.address, 4);
	};

	t.is(await instance('').text(), 'ok');
	t.is(initialLookupCount, 1);
	t.is(replacementLookupCount, 1);
	t.is(lookups.length, 2);
	t.is(lookups[0], lookups[1]);
});

test('custom DNS cache objects can be frozen', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const cache = Object.freeze({
		address: '127.0.0.1',
		lookup(this: {address: string}, _hostname: string, _options: unknown, callback: Parameters<LookupFunction>[2]) {
			callback(null, this.address, 4);
		},
	});

	t.is(await got('', {dnsCache: cache, dnsLookupIpVersion: 4, retry: {limit: 0}}).text(), 'ok');
});

test('explicit DNS lookup takes precedence over a custom cache', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const lookup = createLookup();
	t.is(await got('', {
		dnsLookup: lookup,
		dnsCache: {
			lookup() {
				t.fail('The cache must not be used when dnsLookup is provided');
			},
		},
		hooks: {
			beforeRequest: [options => {
				t.is(options.createNativeRequestOptions().lookup, lookup);
			}],
		},
	}).text(), 'ok');
});
