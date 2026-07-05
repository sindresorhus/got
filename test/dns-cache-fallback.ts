import {setImmediate} from 'node:timers/promises';
import type {LookupFunction} from 'node:net';
import test from 'ava';
import DnsCache from '../source/core/utils/dns-cache.js';

const createDnsError = (code: string) => {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
};

test('DNS cache fallback state is scoped to lookup options', async t => {
	let lookupCallCount = 0;
	let resolve4CallCount = 0;
	let resolve6CallCount = 0;
	const cache = new DnsCache({
		fallbackDuration: 60,
		lookup: ((_hostname: string, options: any, callback: any) => {
			lookupCallCount++;

			if (options.family === 6) {
				callback(new Error('Unexpected IPv6 fallback lookup'));
				return;
			}

			callback(null, [{address: '127.0.0.1', family: 4}]);
		}) as LookupFunction,
		resolver: {
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ENODATA');
			},
			async resolve6() {
				resolve6CallCount++;
				return [{address: '::1', ttl: 60}];
			},
		},
	});

	t.deepEqual(await cache.lookupAsync('example.com', {family: 4}), {
		address: '127.0.0.1',
		family: 4,
	});
	t.deepEqual(await cache.lookupAsync('example.com', {family: 6}), {
		address: '::1',
		family: 6,
	});
	t.is(resolve4CallCount, 1);
	t.is(resolve6CallCount, 1);
	t.is(lookupCallCount, 1);
});

test('DNS cache clears fallback state for all hostnames', async t => {
	let lookupCallCount = 0;
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		fallbackDuration: 60,
		lookup: ((_hostname: string, _options: any, callback: any) => {
			lookupCallCount++;
			callback(null, [{address: '127.0.0.1', family: 4}]);
		}) as LookupFunction,
		resolver: {
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ENOTFOUND');
			},
			async resolve6() {
				return [];
			},
		},
	});

	await cache.lookupAsync('example.com', {family: 4});
	await cache.lookupAsync('example.com', {family: 4});
	cache.clear();
	await cache.lookupAsync('example.com', {family: 4});

	t.is(resolve4CallCount, 2);
	t.is(lookupCallCount, 3);
});

test('DNS cache clears missing fallback state for all hostnames', async t => {
	let lookupCallCount = 0;
	const cache = new DnsCache({
		lookup: ((_hostname: string, _options: any, callback: any) => {
			lookupCallCount++;
			callback(createDnsError('ENOTFOUND'));
		}) as LookupFunction,
		resolver: {
			async resolve4() {
				throw createDnsError('ENOTFOUND');
			},
			async resolve6() {
				return [];
			},
		},
	});

	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});
	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});
	cache.clear();
	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});

	t.is(lookupCallCount, 2);
});

test('DNS cache does not cache fallback state cleared by clearing all hostnames', async t => {
	let resolveLookup!: () => void;
	let lookupCallCount = 0;
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		fallbackDuration: 60,
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
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ENOTFOUND');
			},
			async resolve6() {
				return [];
			},
		},
	});

	const lookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear();
	resolveLookup();

	t.like(await lookup, {address: '127.0.0.1'});

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	resolveLookup();

	t.like(await secondLookup, {address: '127.0.0.1'});
	t.is(resolve4CallCount, 2);
	t.is(lookupCallCount, 2);
});
