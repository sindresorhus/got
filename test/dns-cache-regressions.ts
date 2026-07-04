import {
	ADDRCONFIG,
	ALL,
	V4MAPPED,
} from 'node:dns';
import type {LookupFunction} from 'node:net';
import os from 'node:os';
import {setImmediate} from 'node:timers/promises';
import test from 'ava';
import DnsCache from '../source/core/utils/dns-cache.js';

const createDnsError = (code: string) => {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
};

test('DNS cache returns IPv6 records before mapped IPv4 records when V4MAPPED and ALL are requested', async t => {
	const cache = new DnsCache({
		resolver: {
			resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			resolve6() {
				return [{address: '::1', ttl: 60}];
			},
		},
	});

	t.deepEqual(await cache.lookupAsync('example.com', {
		all: true,
		family: 6,
		hints: V4MAPPED + ALL,
	}), [
		{
			address: '::1',
			family: 6,
		},
		{
			address: '::ffff:127.0.0.1',
			family: 6,
		},
	]);
});

test('DNS cache returns IPv6 records without mapped IPv4 records when V4MAPPED is requested without ALL', async t => {
	const cache = new DnsCache({
		resolver: {
			resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			resolve6() {
				return [{address: '::1', ttl: 60}];
			},
		},
	});

	t.deepEqual(await cache.lookupAsync('example.com', {
		all: true,
		family: 6,
		hints: V4MAPPED,
	}), [
		{
			address: '::1',
			family: 6,
		},
	]);
});

test.serial('DNS cache refreshes ADDRCONFIG interface state for each lookup', async t => {
	const originalNetworkInterfaces = os.networkInterfaces;
	let hasIpv6 = false;
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
			...(hasIpv6
				? [{
					address: '2001:db8::1',
					netmask: 'ffff:ffff:ffff:ffff::',
					family: 'IPv6' as const,
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '2001:db8::1/64',
					scopeid: 0,
				}]
				: []),
		],
	});

	try {
		let resolve6CallCount = 0;
		const cache = new DnsCache({
			lookup: false,
			resolver: {
				resolve4() {
					return [];
				},
				resolve6() {
					resolve6CallCount++;
					return [{address: '::1', ttl: 60}];
				},
			},
		});

		await t.throwsAsync(cache.lookupAsync('example.com', {
			family: 6,
			hints: ADDRCONFIG,
		}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		t.is(resolve6CallCount, 0);

		hasIpv6 = true;
		t.deepEqual(await cache.lookupAsync('example.com', {
			family: 6,
			hints: ADDRCONFIG,
		}), {
			address: '::1',
			family: 6,
		});
		t.is(resolve6CallCount, 1);
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
});

test('DNS cache removes stale async cache set values cleared by hostname without a newer write', async t => {
	let resolveSetWrite!: () => void;
	let resolveSet!: () => void;
	const store = new Map<string, any>();
	let resolve4CallCount = 0;
	let setCallCount = 0;
	const cache = new DnsCache({
		cache: {
			get(key) {
				return store.get(key);
			},
			async set(key, value) {
				setCallCount++;

				if (setCallCount === 1) {
					await new Promise<void>(resolve => {
						resolveSetWrite = resolve;
					});

					store.set(key, structuredClone(value));

					await new Promise<void>(resolve => {
						resolveSet = resolve;
					});

					return;
				}

				store.set(key, structuredClone(value));
			},
			delete(key) {
				return store.delete(key);
			},
		},
		resolver: {
			resolve4() {
				resolve4CallCount++;
				return [{address: `127.0.0.${resolve4CallCount}`, ttl: 60}];
			},
			resolve6() {
				return [];
			},
		},
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveSetWrite();
	await setImmediate();
	resolveSet();

	t.like(await firstLookup, {address: '127.0.0.1'});
	await setImmediate();
	t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	t.is(resolve4CallCount, 2);
});

test('DNS cache shares concurrent fallback lookups', async t => {
	let resolveLookup!: () => void;
	let lookupCallCount = 0;
	const cache = new DnsCache({
		lookup: ((_hostname: string, _options: any, callback: any) => {
			lookupCallCount++;

			void (async () => {
				await new Promise<void>(resolve => {
					resolveLookup = resolve;
				});

				callback(null, [{address: '127.0.0.1', family: 4}]);
			})();
		}) as LookupFunction,
		resolver: {
			resolve4() {
				throw createDnsError('ENOTFOUND');
			},
			resolve6() {
				return [];
			},
		},
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	resolveLookup();

	t.deepEqual(await Promise.all([firstLookup, secondLookup]), [
		{
			address: '127.0.0.1',
			family: 4,
		},
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);
	t.is(lookupCallCount, 1);
});

test('DNS cache does not share concurrent fallback lookups with different result orders', async t => {
	const resolveLookups: Array<() => void> = [];
	let lookupCallCount = 0;
	const cache = new DnsCache({
		lookup: ((_hostname: string, options: any, callback: any) => {
			lookupCallCount++;

			void (async () => {
				await new Promise<void>(resolve => {
					resolveLookups.push(resolve);
				});

				const entries = [
					{address: '127.0.0.1', family: 4},
					{address: '::1', family: 6},
				];
				callback(null, options.order === 'ipv6first' ? entries.reverse() : entries);
			})();
		}) as LookupFunction,
		resolver: {
			resolve4() {
				throw createDnsError('ENOTFOUND');
			},
			resolve6() {
				throw createDnsError('ENOTFOUND');
			},
		},
	});

	const firstLookup = cache.lookupAsync('example.com', {all: true, order: 'ipv4first'});
	const secondLookup = cache.lookupAsync('example.com', {all: true, order: 'ipv6first'});
	await setImmediate();
	for (const resolveLookup of resolveLookups) {
		resolveLookup();
	}

	t.deepEqual(await firstLookup, [
		{
			address: '127.0.0.1',
			family: 4,
		},
		{
			address: '::1',
			family: 6,
		},
	]);
	t.deepEqual(await secondLookup, [
		{
			address: '::1',
			family: 6,
		},
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);
	t.is(lookupCallCount, 2);
});

test('DNS cache propagates non-missing fallback lookup errors', async t => {
	const cache = new DnsCache({
		lookup: ((_hostname: string, _options: any, callback: any) => {
			callback(createDnsError('ESERVFAIL'));
		}) as LookupFunction,
		resolver: {
			resolve4() {
				throw createDnsError('ENOTFOUND');
			},
			resolve6() {
				return [];
			},
		},
	});

	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'ESERVFAIL',
	});
});
