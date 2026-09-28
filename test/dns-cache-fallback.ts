import {setImmediate} from 'node:timers/promises';
import type {LookupFunction} from 'node:net';
import assert from 'node:assert/strict';
import DnsCache from '../source/core/utils/dns-cache.js';
import test from './helpers/test.js';

const createDnsError = (code: string) => {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
};

test('DNS cache fallback state is scoped to lookup options', async _t => {
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

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {
		address: '127.0.0.1',
		family: 4,
	});
	assert.deepStrictEqual(await cache.lookupAsync('example.com', {family: 6}), {
		address: '::1',
		family: 6,
	});
	assert.strictEqual(resolve4CallCount, 1);
	assert.strictEqual(resolve6CallCount, 1);
	assert.strictEqual(lookupCallCount, 1);
});

test('DNS cache clears fallback state for all hostnames', async _t => {
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

	assert.strictEqual(resolve4CallCount, 2);
	assert.strictEqual(lookupCallCount, 3);
});

test('DNS cache clears missing fallback state for all hostnames', async _t => {
	let lookupCallCount = 0;
	const cache = new DnsCache({
		errorTtl: 60,
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

	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});
	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});
	cache.clear();
	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});

	assert.strictEqual(lookupCallCount, 2);
});

test('DNS cache does not cache fallback state cleared by clearing all hostnames', async _t => {
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

	assert.partialDeepStrictEqual(await lookup, {address: '127.0.0.1'});

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	resolveLookup();

	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.1'});
	assert.strictEqual(resolve4CallCount, 2);
	assert.strictEqual(lookupCallCount, 2);
});
