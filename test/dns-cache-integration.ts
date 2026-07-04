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
