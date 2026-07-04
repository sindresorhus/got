import {ADDRCONFIG, V4MAPPED} from 'node:dns';
import {setImmediate} from 'node:timers/promises';
import type {LookupFunction} from 'node:net';
import os from 'node:os';
import FakeTimers from '@sinonjs/fake-timers';
import test from 'ava';
import DnsCache from '../source/core/utils/dns-cache.js';
import withServer from './helpers/with-server.js';

const createResolver = ({
	resolve4 = async () => [],
	resolve6 = async () => [],
}: {
	resolve4?: (hostname: string) => Promise<Array<{address: string; ttl: number}>>;
	resolve6?: (hostname: string) => Promise<Array<{address: string; ttl: number}>>;
}) => ({
	resolve4,
	resolve6,
});

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

const createDnsError = (code: string) => {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
};

test('DNS cache reuses resolved entries', async t => {
	let resolve4CallCount = 0;
	let resolve6CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				resolve6CallCount++;
				return [{address: '::1', ttl: 60}];
			},
		}),
	});

	await cache.lookupAsync('example.com');
	await cache.lookupAsync('example.com');

	t.is(resolve4CallCount, 1);
	t.is(resolve6CallCount, 1);
});

test('DNS cache only resolves the requested IPv4 family', async t => {
	let resolve4CallCount = 0;
	let resolve6CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				resolve6CallCount++;
				return [{address: '::1', ttl: 60}];
			},
		}),
	});

	const result = await cache.lookupAsync('example.com', {family: 4});

	t.like(result, {
		address: '127.0.0.1',
		family: 4,
	});
	t.is(resolve4CallCount, 1);
	t.is(resolve6CallCount, 0);
});

test('DNS cache only resolves the requested IPv6 family', async t => {
	let resolve4CallCount = 0;
	let resolve6CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				resolve6CallCount++;
				return [{address: '::1', ttl: 60}];
			},
		}),
	});

	const result = await cache.lookupAsync('example.com', {family: 6});

	t.like(result, {
		address: '::1',
		family: 6,
	});
	t.is(resolve4CallCount, 0);
	t.is(resolve6CallCount, 1);
});

test('DNS cache supports callback lookup shape', async t => {
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
		}),
	});

	await new Promise<void>((resolve, reject) => {
		cache.lookup('example.com', {}, (error, address, family) => {
			if (error) {
				reject(error);
				return;
			}

			t.is(typeof address, 'string');
			t.is(address, '127.0.0.1');
			t.is(family, 4);
			resolve();
		});
	});
});

test('DNS cache supports all lookup results', async t => {
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				return [{address: '::1', ttl: 60}];
			},
		}),
	});

	await new Promise<void>((resolve, reject) => {
		cache.lookup('example.com', {all: true}, (error, entries) => {
			if (error) {
				reject(error);
				return;
			}

			t.deepEqual(entries, [
				{
					address: '127.0.0.1',
					family: 4,
				},
				{
					address: '::1',
					family: 6,
				},
			]);
			resolve();
		});
	});
});

test('DNS cache delegates IP literals to dns.lookup-compatible fallback', async t => {
	let resolveCallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolveCallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				resolveCallCount++;
				return [{address: '::1', ttl: 60}];
			},
		}),
	});

	const result = await cache.lookupAsync('::ffff:127.0.0.1');

	t.like(result, {
		address: '::ffff:127.0.0.1',
		family: 6,
	});
	t.is(resolveCallCount, 0);
});

test('DNS cache handles IP literals when fallback lookup is disabled', async t => {
	const cache = new DnsCache({
		lookup: false,
	});

	t.deepEqual(await cache.lookupAsync('127.0.0.1', {all: true}), [
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);
	t.deepEqual(await cache.lookupAsync('::ffff:127.0.0.1'), {
		address: '::ffff:127.0.0.1',
		family: 6,
	});
});

test('DNS cache maps IPv4 results when V4MAPPED is requested', async t => {
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				return [];
			},
		}),
	});

	const result = await cache.lookupAsync('example.com', {
		family: 6,
		hints: V4MAPPED,
	});

	t.like(result, {
		address: '::ffff:127.0.0.1',
		family: 6,
	});
});

test.serial('DNS cache filters ADDRCONFIG lookups', async t => {
	const originalNetworkInterfaces = os.networkInterfaces;
	os.networkInterfaces = () => ({
		en0: [
			{
				address: '192.168.0.1',
				netmask: '255.255.255.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: false,
				cidr: '192.168.0.1/24',
			},
		],
	});

	try {
		const cache = new DnsCache({
			resolver: createResolver({
				async resolve4() {
					return [{address: '127.0.0.1', ttl: 60}];
				},
				async resolve6() {
					return [{address: '::1', ttl: 60}];
				},
			}),
		});

		const result = await cache.lookupAsync('example.com', {
			all: true,
			hints: ADDRCONFIG,
		});

		t.deepEqual(result, [
			{
				address: '127.0.0.1',
				family: 4,
			},
		]);
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
});

test.serial('DNS cache expires entries lazily', async t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		let resolve4CallCount = 0;
		const cache = new DnsCache({
			resolver: createResolver({
				async resolve4() {
					resolve4CallCount++;
					return [{address: '127.0.0.1', ttl: 1}];
				},
			}),
		});

		await cache.lookupAsync('example.com', {family: 4});
		await cache.lookupAsync('example.com', {family: 4});
		clock.tick(1001);
		await cache.lookupAsync('example.com', {family: 4});

		t.is(resolve4CallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache does not schedule timers for large TTLs', async t => {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (() => {
		throw new Error('Unexpected timer');
	}) as unknown as typeof setTimeout;

	try {
		const cache = new DnsCache({
			resolver: createResolver({
				async resolve4() {
					return [{address: '127.0.0.1', ttl: 2_419_200}];
				},
			}),
		});

		await t.notThrowsAsync(cache.lookupAsync('example.com', {family: 4}));
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test('DNS cache shares concurrent lookups for the same hostname and family', async t => {
	let resolvePending!: () => void;
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				await new Promise<void>(resolve => {
					resolvePending = resolve;
				});

				return [{address: '127.0.0.1', ttl: 60}];
			},
		}),
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	const secondLookup = cache.lookupAsync('example.com', {family: 4});

	await setImmediate();
	resolvePending();

	const [firstResult, secondResult] = await Promise.all([firstLookup, secondLookup]);

	t.like(firstResult, {address: '127.0.0.1'});
	t.like(secondResult, {address: '127.0.0.1'});
	t.is(resolve4CallCount, 1);
});

test('DNS cache supports async cache stores', async t => {
	const store = new Map<string, any>();
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		cache: {
			async get(key) {
				return store.get(key);
			},
			set(key, value) {
				store.set(key, value);
			},
			delete(key) {
				store.delete(key);
			},
			clear() {
				store.clear();
			},
		},
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
		}),
	});

	await cache.lookupAsync('example.com', {family: 4});
	await cache.lookupAsync('example.com', {family: 4});

	t.is(resolve4CallCount, 1);
});

test.serial('DNS cache falls back to dns.lookup per hostname', async t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		let resolve4CallCount = 0;
		let lookupCallCount = 0;
		const cache = new DnsCache({
			errorTtl: 0,
			fallbackDuration: 1,
			lookup: ((_hostname: string, options: any, callback: any) => {
				lookupCallCount++;

				if (options.all) {
					callback(null, [{address: '127.0.0.1', family: 4}]);
					return;
				}

				callback(null, '127.0.0.1', 4);
			}) as LookupFunction,
			resolver: createResolver({
				async resolve4() {
					resolve4CallCount++;
					throw createDnsError('ENODATA');
				},
				async resolve6() {
					throw createDnsError('ENODATA');
				},
			}),
		});

		await cache.lookupAsync('example.com');
		await cache.lookupAsync('example.com');
		await cache.lookupAsync('example.net');
		clock.tick(1001);
		await cache.lookupAsync('example.com');

		t.is(resolve4CallCount, 3);
		t.is(lookupCallCount, 4);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache negative-caches missing records', async t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		let resolve4CallCount = 0;
		const cache = new DnsCache({
			lookup: false,
			resolver: createResolver({
				async resolve4() {
					resolve4CallCount++;
					throw createDnsError('ENOTFOUND');
				},
			}),
		});

		await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		clock.tick(151);
		await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		t.is(resolve4CallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache negative-caches missing fallback lookups', async t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		let lookupCallCount = 0;
		let resolve4CallCount = 0;
		const cache = new DnsCache({
			lookup: ((_hostname: string, _options: any, callback: any) => {
				lookupCallCount++;
				callback(createDnsError('ENOTFOUND'));
			}) as LookupFunction,
			resolver: createResolver({
				async resolve4() {
					resolve4CallCount++;
					throw createDnsError('ENOTFOUND');
				},
			}),
		});

		await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		clock.tick(151);
		await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		t.is(resolve4CallCount, 2);
		t.is(lookupCallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test('DNS cache propagates resolver failures', async t => {
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ESERVFAIL');
			},
		}),
	});

	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'ESERVFAIL',
	});
	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'ESERVFAIL',
	});

	t.is(resolve4CallCount, 2);
});

test('Got uses internal DNS cache lookup option', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
		}),
	});
	const instance = got.extend({
		dnsCache: cache,
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
