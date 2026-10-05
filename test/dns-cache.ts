import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
import {
	ADDRCONFIG,
	getDefaultResultOrder,
	setDefaultResultOrder,
	V4MAPPED,
	ALL,
	type LookupOptions,
} from 'node:dns';
import process from 'node:process';
import {setImmediate} from 'node:timers/promises';
import type {LookupFunction} from 'node:net';
import os from 'node:os';
import {promisify} from 'node:util';
import FakeTimers from '@sinonjs/fake-timers';
import DnsCache from '../source/core/utils/dns-cache.js';
import test from './helpers/test.js';

const execFileAsync = promisify(execFile);

const createResolver = ({
	resolve4 = async () => [],
	resolve6 = async () => [],
}: {
	resolve4?: (hostname: string) => Promise<Array<{address: string; ttl: number}>>;
	resolve6?: (hostname: string) => Promise<Array<{address: string; ttl: number}>>;
}) => ({
	resolve4(hostname: string, options: {ttl: true}) {
		assert.deepEqual(options, {ttl: true});
		return resolve4(hostname);
	},
	resolve6(hostname: string, options: {ttl: true}) {
		assert.deepEqual(options, {ttl: true});
		return resolve6(hostname);
	},
});

const createDnsError = (code: string) => {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
};

test('DNS cache reuses resolved entries', async _t => {
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

	assert.strictEqual(resolve4CallCount, 1);
	assert.strictEqual(resolve6CallCount, 1);
});

test('DNS cache only resolves the requested IPv4 family', async _t => {
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

	assert.partialDeepStrictEqual(result, {
		address: '127.0.0.1',
		family: 4,
	});
	assert.strictEqual(resolve4CallCount, 1);
	assert.strictEqual(resolve6CallCount, 0);
});

test('DNS cache only resolves the requested IPv6 family', async _t => {
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

	const result = await cache.lookupAsync('example.com', {family: 'IPv6'});

	assert.partialDeepStrictEqual(result, {
		address: '::1',
		family: 6,
	});
	assert.strictEqual(resolve4CallCount, 0);
	assert.strictEqual(resolve6CallCount, 1);
});

test('DNS cache supports callback lookup shape', async _t => {
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

			assert.strictEqual(typeof address, 'string');
			assert.strictEqual(address, '127.0.0.1');
			assert.strictEqual(family, 4);
			resolve();
		});
	});
});

test('DNS cache supports all lookup results', async _t => {
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

			assert.deepStrictEqual(entries, [
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

test('DNS cache supports lookup result order', async _t => {
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

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {
		all: true,
		order: 'ipv6first',
	}), [
		{
			address: '::1',
			family: 6,
		},
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {
		all: true,
		order: 'verbatim',
	}), [
		{
			address: '127.0.0.1',
			family: 4,
		},
		{
			address: '::1',
			family: 6,
		},
	]);
});

test.serial('DNS cache uses the default DNS result order', async _t => {
	const originalOrder = getDefaultResultOrder();
	setDefaultResultOrder('ipv6first');

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

		assert.deepStrictEqual(await cache.lookupAsync('example.com', {all: true}), [
			{
				address: '::1',
				family: 6,
			},
			{
				address: '127.0.0.1',
				family: 4,
			},
		]);
		assert.deepStrictEqual(await cache.lookupAsync('example.com', {
			all: true,
			verbatim: false,
		}), [
			{
				address: '127.0.0.1',
				family: 4,
			},
			{
				address: '::1',
				family: 6,
			},
		]);
	} finally {
		setDefaultResultOrder(originalOrder);
	}
});

test('DNS cache handles IP literals without resolver lookups', async _t => {
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

	assert.partialDeepStrictEqual(result, {
		address: '::ffff:127.0.0.1',
		family: 6,
	});
	assert.strictEqual(resolveCallCount, 0);
});

test('DNS cache handles IP literals when fallback lookup is disabled', async _t => {
	const cache = new DnsCache({
		lookup: false,
	});

	assert.deepStrictEqual(await cache.lookupAsync('127.0.0.1', {all: true}), [
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);
	assert.deepStrictEqual(await cache.lookupAsync('::ffff:127.0.0.1'), {
		address: '::ffff:127.0.0.1',
		family: 6,
	});
});

test('DNS cache passes resolver errors to lookup callbacks', async _t => {
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				throw createDnsError('ESERVFAIL');
			},
		}),
	});

	await new Promise<void>(resolve => {
		cache.lookup('example.com', {family: 4}, error => {
			assert.strictEqual(error?.code, 'ESERVFAIL');
			resolve();
		});
	});
});

test('DNS cache does not call callbacks twice when callbacks throw', async _t => {
	const script = [
		'import DnsCache from "./source/core/utils/dns-cache.ts";',
		'let callCount = 0;',
		'const cache = new DnsCache({',
		'resolver: {',
		'async resolve4() {',
		'return [{address: "127.0.0.1", ttl: 60}];',
		'},',
		'async resolve6() {',
		'return [];',
		'},',
		'},',
		'});',
		'process.on("unhandledRejection", error => {',
		'console.error(error);',
		'process.exit(1);',
		'});',
		'process.on("uncaughtException", error => {',
		'if (error?.message !== "Callback failure") {',
		'console.error(error);',
		'process.exit(1);',
		'}',
		'setImmediate(() => {',
		'console.log(callCount);',
		'process.exit(callCount === 1 ? 0 : 1);',
		'});',
		'});',
		'cache.lookup("example.com", {family: 4}, () => {',
		'callCount++;',
		'throw new Error("Callback failure");',
		'});',
		'setTimeout(() => {',
		'console.error("Missing callback exception");',
		'process.exit(1);',
		'}, 1000);',
	].join('\n');

	const {stdout} = await execFileAsync(process.execPath, [
		'--import=tsx/esm',
		'--input-type=module',
		'--eval',
		script,
	], {
		cwd: process.cwd(),
	});

	assert.strictEqual(stdout.trim(), '1');
});

test('DNS cache does not call error callbacks twice when callbacks throw', async _t => {
	const script = [
		'import DnsCache from "./source/core/utils/dns-cache.ts";',
		'let callCount = 0;',
		'const cache = new DnsCache({',
		'resolver: {',
		'async resolve4() {',
		'const error = new Error("ESERVFAIL");',
		'error.code = "ESERVFAIL";',
		'throw error;',
		'},',
		'async resolve6() {',
		'return [];',
		'},',
		'},',
		'});',
		'process.on("unhandledRejection", error => {',
		'console.error(error);',
		'process.exit(1);',
		'});',
		'process.on("uncaughtException", error => {',
		'if (error?.message !== "Callback failure") {',
		'console.error(error);',
		'process.exit(1);',
		'}',
		'setImmediate(() => {',
		'console.log(callCount);',
		'process.exit(callCount === 1 ? 0 : 1);',
		'});',
		'});',
		'cache.lookup("example.com", {family: 4}, error => {',
		'callCount++;',
		'if (error?.code !== "ESERVFAIL") {',
		'throw error;',
		'}',
		'throw new Error("Callback failure");',
		'});',
		'setTimeout(() => {',
		'console.error("Missing callback exception");',
		'process.exit(1);',
		'}, 1000);',
	].join('\n');

	const {stdout} = await execFileAsync(process.execPath, [
		'--import=tsx/esm',
		'--input-type=module',
		'--eval',
		script,
	], {
		cwd: process.cwd(),
	});

	assert.strictEqual(stdout.trim(), '1');
});

test('DNS cache maps IPv4 results when V4MAPPED is requested', async _t => {
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

	assert.partialDeepStrictEqual(result, {
		address: '::ffff:127.0.0.1',
		family: 6,
	});
});

test.serial('DNS cache applies ADDRCONFIG before V4MAPPED filtering', async _t => {
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
			lookup: false,
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
			hints: V4MAPPED + ADDRCONFIG,
		});

		assert.deepStrictEqual(result, {
			address: '::ffff:127.0.0.1',
			family: 6,
		});
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
});

test.serial('DNS cache filters ADDRCONFIG lookups', async _t => {
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
		let resolve6CallCount = 0;
		const cache = new DnsCache({
			resolver: createResolver({
				async resolve4() {
					return [{address: '127.0.0.1', ttl: 60}];
				},
				async resolve6() {
					resolve6CallCount++;
					throw createDnsError('ESERVFAIL');
				},
			}),
		});

		const result = await cache.lookupAsync('example.com', {
			all: true,
			hints: ADDRCONFIG,
		});

		assert.deepStrictEqual(result, [
			{
				address: '127.0.0.1',
				family: 4,
			},
		]);
		assert.strictEqual(resolve6CallCount, 0);
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
});

test('DNS cache clears one hostname', async _t => {
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
		}),
	});

	await cache.lookupAsync('example.com', {family: 4});
	await cache.lookupAsync('example.com', {family: 4});
	cache.clear('example.com');
	await cache.lookupAsync('example.com', {family: 4});

	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache keeps other hostnames cached when one hostname is cleared', async _t => {
	const resolveCallCounts = new Map<string, number>();
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4(hostname) {
				resolveCallCounts.set(hostname, (resolveCallCounts.get(hostname) ?? 0) + 1);
				return [{address: hostname === 'example.com' ? '127.0.0.1' : '127.0.0.2', ttl: 60}];
			},
		}),
	});

	await cache.lookupAsync('example.com', {family: 4});
	await cache.lookupAsync('example.net', {family: 4});
	cache.clear('example.com');

	assert.partialDeepStrictEqual(await cache.lookupAsync('example.net', {family: 4}), {address: '127.0.0.2'});
	assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.1'});
	assert.strictEqual(resolveCallCounts.get('example.com'), 2);
	assert.strictEqual(resolveCallCounts.get('example.net'), 1);
});

test('DNS cache caches in-flight lookups for other hostnames when one hostname is cleared', async _t => {
	let resolveExampleNet!: () => void;
	const resolveCallCounts = new Map<string, number>();
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4(hostname) {
				resolveCallCounts.set(hostname, (resolveCallCounts.get(hostname) ?? 0) + 1);

				if (hostname === 'example.net') {
					await new Promise<void>(resolve => {
						resolveExampleNet = resolve;
					});
				}

				return [{address: hostname === 'example.com' ? '127.0.0.1' : '127.0.0.2', ttl: 60}];
			},
		}),
	});

	const lookup = cache.lookupAsync('example.net', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveExampleNet();

	assert.partialDeepStrictEqual(await lookup, {address: '127.0.0.2'});
	assert.partialDeepStrictEqual(await cache.lookupAsync('example.net', {family: 4}), {address: '127.0.0.2'});
	assert.strictEqual(resolveCallCounts.get('example.com'), undefined);
	assert.strictEqual(resolveCallCounts.get('example.net'), 1);
});

test('DNS cache does not cache in-flight lookups cleared by hostname', async _t => {
	const pendingResolvers: Array<() => void> = [];
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				const callCount = resolve4CallCount;

				await new Promise<void>(resolve => {
					pendingResolvers.push(resolve);
				});

				return [{address: `127.0.0.${callCount}`, ttl: 60}];
			},
		}),
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();

	pendingResolvers[0]!();
	await setImmediate();

	const thirdLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();

	assert.strictEqual(resolve4CallCount, 2);

	pendingResolvers[1]!();

	assert.partialDeepStrictEqual(await firstLookup, {address: '127.0.0.1'});
	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.2'});
	assert.partialDeepStrictEqual(await thirdLookup, {address: '127.0.0.2'});

	await cache.lookupAsync('example.com', {family: 4});

	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache ignores async cache get results cleared by hostname', async _t => {
	let resolveGet!: () => void;
	const store = new Map<string, any>([
		['example.com:4', {
			entries: [
				{
					address: '127.0.0.1',
					family: 4,
					expires: Date.now() + 60_000,
				},
			],
			expires: Date.now() + 60_000,
			clearVersion: 0,
		}],
	]);
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		cache: {
			async get(key) {
				const snapshot = store.get(key);

				await new Promise<void>(resolve => {
					resolveGet = resolve;
				});

				return snapshot;
			},
			set(key, value) {
				store.set(key, value);
			},
			delete(key) {
				return store.delete(key);
			},
		},
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.2', ttl: 60}];
			},
		}),
	});

	const lookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveGet();

	assert.partialDeepStrictEqual(await lookup, {address: '127.0.0.2'});
	assert.strictEqual(resolve4CallCount, 1);
});

test('DNS cache does not publish stale pending lookups after async cache gets cleared by hostname', async _t => {
	let resolveGet!: () => void;
	const pendingResolvers: Array<() => void> = [];
	let getCallCount = 0;
	let resolve4CallCount = 0;
	const store = new Map<string, any>();
	const cache = new DnsCache({
		cache: {
			async get(key) {
				getCallCount++;

				if (getCallCount === 1) {
					await new Promise<void>(resolve => {
						resolveGet = resolve;
					});
				}

				return store.get(key);
			},
			set(key, value) {
				store.set(key, value);
			},
			delete(key) {
				return store.delete(key);
			},
		},
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				const callCount = resolve4CallCount;

				await new Promise<void>(resolve => {
					pendingResolvers.push(resolve);
				});

				return [{address: `127.0.0.${callCount}`, ttl: 60}];
			},
		}),
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveGet();
	await setImmediate();

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();

	assert.strictEqual(resolve4CallCount, 2);

	pendingResolvers[0]!();
	pendingResolvers[1]!();

	assert.partialDeepStrictEqual(await firstLookup, {address: '127.0.0.1'});
	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.2'});
	assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache ignores stale async cache set values cleared by hostname', async _t => {
	let resolveStaleSetWrite!: () => void;
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
						resolveStaleSetWrite = resolve;
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
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: `127.0.0.${resolve4CallCount}`, ttl: 60}];
			},
		}),
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveStaleSetWrite();
	await setImmediate();

	assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	resolveSet();
	assert.partialDeepStrictEqual(await firstLookup, {address: '127.0.0.1'});
	assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache clears fallback state for one hostname', async _t => {
	let resolve4CallCount = 0;
	let lookupCallCount = 0;
	const cache = new DnsCache({
		fallbackDuration: 60,
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
				throw createDnsError('ENOTFOUND');
			},
		}),
	});

	await cache.lookupAsync('example.com', {family: 4});
	cache.clear('example.com');
	await cache.lookupAsync('example.com', {family: 4});

	assert.strictEqual(resolve4CallCount, 2);
	assert.strictEqual(lookupCallCount, 2);
});

test('DNS cache caches fallback state for other hostnames when one hostname is cleared', async _t => {
	let resolveLookup!: () => void;
	let resolve4CallCount = 0;
	let lookupCallCount = 0;
	const cache = new DnsCache({
		fallbackDuration: 60,
		lookup: ((_hostname: string, options: any, callback: any) => {
			lookupCallCount++;

			void (async () => {
				await new Promise<void>(resolve => {
					resolveLookup = resolve;
				});

				if (options.all) {
					callback(null, [{address: '127.0.0.1', family: 4}]);
					return;
				}

				callback(null, '127.0.0.1', 4);
			})();
		}) as LookupFunction,
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ENOTFOUND');
			},
		}),
	});

	const lookup = cache.lookupAsync('example.net', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveLookup();

	assert.partialDeepStrictEqual(await lookup, {address: '127.0.0.1'});

	const secondLookup = cache.lookupAsync('example.net', {family: 4});
	await setImmediate();
	resolveLookup();

	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.1'});
	assert.strictEqual(resolve4CallCount, 1);
	assert.strictEqual(lookupCallCount, 2);
});

test('DNS cache does not cache fallback state cleared by hostname', async _t => {
	let resolveLookup!: () => void;
	let resolve4CallCount = 0;
	let lookupCallCount = 0;
	const cache = new DnsCache({
		fallbackDuration: 60,
		lookup: ((_hostname: string, options: any, callback: any) => {
			lookupCallCount++;

			void (async () => {
				await new Promise<void>(resolve => {
					resolveLookup = resolve;
				});

				if (options.all) {
					callback(null, [{address: '127.0.0.1', family: 4}]);
					return;
				}

				callback(null, '127.0.0.1', 4);
			})();
		}) as LookupFunction,
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ENOTFOUND');
			},
		}),
	});

	const lookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');
	resolveLookup();

	assert.partialDeepStrictEqual(await lookup, {address: '127.0.0.1'});

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	resolveLookup();

	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.1'});
	assert.strictEqual(resolve4CallCount, 2);
	assert.strictEqual(lookupCallCount, 2);
});

test('DNS cache clears all hostnames', async _t => {
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
		}),
	});

	await cache.lookupAsync('example.com', {family: 4});
	await cache.lookupAsync('example.net', {family: 4});
	cache.clear();
	await cache.lookupAsync('example.com', {family: 4});
	await cache.lookupAsync('example.net', {family: 4});

	assert.strictEqual(resolve4CallCount, 4);
});

test('DNS cache does not cache in-flight lookups cleared by clearing all hostnames', async _t => {
	const pendingResolvers: Array<() => void> = [];
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				const callCount = resolve4CallCount;

				await new Promise<void>(resolve => {
					pendingResolvers.push(resolve);
				});

				return [{address: `127.0.0.${callCount}`, ttl: 60}];
			},
		}),
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear();

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();

	pendingResolvers[0]!();
	await setImmediate();

	const thirdLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();

	assert.strictEqual(resolve4CallCount, 2);

	pendingResolvers[1]!();

	assert.partialDeepStrictEqual(await firstLookup, {address: '127.0.0.1'});
	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.2'});
	assert.partialDeepStrictEqual(await thirdLookup, {address: '127.0.0.2'});

	assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});

	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache preserves hostname invalidation when old globally cleared lookups finish first', async _t => {
	const pendingResolvers: Array<() => void> = [];
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				const callCount = resolve4CallCount;

				await new Promise<void>(resolve => {
					pendingResolvers.push(resolve);
				});

				return [{address: `127.0.0.${callCount}`, ttl: 60}];
			},
		}),
	});

	const firstLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear();

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	cache.clear('example.com');

	pendingResolvers[0]!();
	await setImmediate();
	pendingResolvers[1]!();

	assert.partialDeepStrictEqual(await firstLookup, {address: '127.0.0.1'});
	assert.partialDeepStrictEqual(await secondLookup, {address: '127.0.0.2'});

	const thirdLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	pendingResolvers[2]!();

	assert.partialDeepStrictEqual(await thirdLookup, {address: '127.0.0.3'});
	assert.strictEqual(resolve4CallCount, 3);
});

test('DNS cache clears missing fallback state for one hostname', async _t => {
	let lookupCallCount = 0;
	const cache = new DnsCache({
		lookup: ((_hostname: string, _options: any, callback: any) => {
			lookupCallCount++;
			callback(createDnsError('ENOTFOUND'));
		}) as LookupFunction,
		resolver: createResolver({
			async resolve4() {
				throw createDnsError('ENOTFOUND');
			},
		}),
	});

	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});
	cache.clear('example.com');
	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});

	assert.strictEqual(lookupCallCount, 2);
});

test.serial('DNS cache expires entries lazily', async _t => {
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

		assert.strictEqual(resolve4CallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache purges expired entries lazily on write', async _t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		const store = new Map<string, any>();
		const cache = new DnsCache({
			cache: store,
			resolver: createResolver({
				async resolve4(hostname) {
					return [{address: hostname === 'example.com' ? '127.0.0.1' : '127.0.0.2', ttl: 1}];
				},
			}),
		});

		await cache.lookupAsync('example.com', {family: 4});
		assert.strictEqual(store.has('example.com:4'), true);

		clock.tick(1001);
		await cache.lookupAsync('example.net', {family: 4});

		assert.strictEqual(store.has('example.com:4'), false);
		assert.strictEqual(store.has('example.net:4'), true);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache purges expired async cache entries lazily on write', async _t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		const store = new Map<string, any>();
		const cache = new DnsCache({
			cache: {
				async get(key) {
					return store.get(key);
				},
				set(key, value) {
					store.set(key, value);
				},
				delete(key) {
					return store.delete(key);
				},
			},
			resolver: createResolver({
				async resolve4(hostname) {
					return [{address: hostname === 'example.com' ? '127.0.0.1' : '127.0.0.2', ttl: 1}];
				},
			}),
		});

		await cache.lookupAsync('example.com', {family: 4});
		assert.strictEqual(store.has('example.com:4'), true);

		clock.tick(1001);
		await cache.lookupAsync('example.net', {family: 4});

		assert.strictEqual(store.has('example.com:4'), false);
		assert.strictEqual(store.has('example.net:4'), true);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache caps large TTLs and expires them lazily without timers', async _t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (() => {
		throw new Error('Unexpected timer');
	}) as unknown as typeof setTimeout;

	try {
		let resolve4CallCount = 0;
		const cache = new DnsCache({
			resolver: createResolver({
				async resolve4() {
					resolve4CallCount++;
					return [{address: `127.0.0.${resolve4CallCount}`, ttl: 2_419_200}];
				},
			}),
		});

		assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.1'});
		clock.tick(2_147_482_999);
		assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.1'});
		clock.tick(1);
		assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
		assert.strictEqual(resolve4CallCount, 2);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		clock.uninstall();
	}
});

test('DNS cache shares concurrent lookups for the same hostname and family', async _t => {
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

	assert.partialDeepStrictEqual(firstResult, {address: '127.0.0.1'});
	assert.partialDeepStrictEqual(secondResult, {address: '127.0.0.1'});
	assert.strictEqual(resolve4CallCount, 1);
});

test('DNS cache supports async cache reads and writes', async _t => {
	const store = new Map<string, any>();
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		cache: {
			async get(key) {
				return store.get(key);
			},
			async set(key, value) {
				store.set(key, value);
			},
			delete(key) {
				return store.delete(key);
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

	assert.strictEqual(resolve4CallCount, 1);
});

test.serial('DNS cache falls back to dns.lookup per hostname', async _t => {
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

		assert.strictEqual(resolve4CallCount, 3);
		assert.strictEqual(lookupCallCount, 4);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache negative-caches missing records', async _t => {
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

		await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		clock.tick(151);
		await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		assert.strictEqual(resolve4CallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache negative-caches missing fallback lookups', async _t => {
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

		await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		clock.tick(151);
		await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		assert.strictEqual(resolve4CallCount, 2);
		assert.strictEqual(lookupCallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache normalizes string family aliases for missing fallback lookups', async _t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		let lookupCallCount = 0;
		let resolve6CallCount = 0;
		const cache = new DnsCache({
			lookup: ((_hostname: string, _options: any, callback: any) => {
				lookupCallCount++;
				callback(createDnsError('ENOTFOUND'));
			}) as LookupFunction,
			resolver: createResolver({
				async resolve6() {
					resolve6CallCount++;
					throw createDnsError('ENOTFOUND');
				},
			}),
		});

		await assert.rejects(cache.lookupAsync('example.com', {family: 'IPv6'}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await assert.rejects(cache.lookupAsync('example.com', {family: 6}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		assert.strictEqual(resolve6CallCount, 1);
		assert.strictEqual(lookupCallCount, 1);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache negative-caches missing fallback lookups per option set', async _t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});

	try {
		let lookupCallCount = 0;
		const cache = new DnsCache({
			lookup: ((_hostname: string, options: any, callback: any) => {
				lookupCallCount++;

				if (options.family === 6) {
					callback(createDnsError('ENOTFOUND'));
					return;
				}

				callback(null, [{address: '127.0.0.1', family: 4}]);
			}) as LookupFunction,
			resolver: createResolver({
				async resolve4() {
					throw createDnsError('ENOTFOUND');
				},
				async resolve6() {
					throw createDnsError('ENOTFOUND');
				},
			}),
		});

		await assert.rejects(cache.lookupAsync('example.com', {family: 6}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await assert.rejects(cache.lookupAsync('example.com', {family: 6}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {
			address: '127.0.0.1',
			family: 4,
		});
		assert.strictEqual(lookupCallCount, 2);
	} finally {
		clock.uninstall();
	}
});

test('DNS cache propagates resolver failures', async _t => {
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				resolve4CallCount++;
				throw createDnsError('ESERVFAIL');
			},
		}),
	});

	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'ESERVFAIL',
	});
	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'ESERVFAIL',
	});

	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache uses successful family results when another family fails', async _t => {
	let resolve6CallCount = 0;
	const cache = new DnsCache({
		lookup: false,
		resolver: createResolver({
			async resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				resolve6CallCount++;
				throw createDnsError('ESERVFAIL');
			},
		}),
	});
	const result = await cache.lookupAsync('example.com');
	assert.deepStrictEqual(result, {address: '127.0.0.1', family: 4});
	assert.strictEqual(resolve6CallCount, 1);
	assert.deepStrictEqual(await cache.lookupAsync('example.net', {all: true, order: 'ipv6first'}), [{address: '127.0.0.1', family: 4}]);
	assert.strictEqual(resolve6CallCount, 2);
});

test('DNS cache returns IPv6 records before mapped IPv4 records when V4MAPPED and ALL are requested', async _t => {
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

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {
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

test('DNS cache returns IPv6 records without mapped IPv4 records when V4MAPPED is requested without ALL', async _t => {
	let resolve4CallCount = 0;
	const cache = new DnsCache({
		resolver: {
			resolve4() {
				resolve4CallCount++;
				return [{address: '127.0.0.1', ttl: 60}];
			},
			resolve6() {
				return [{address: '::1', ttl: 60}];
			},
		},
	});

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {
		all: true,
		family: 6,
		hints: V4MAPPED,
	}), [
		{
			address: '::1',
			family: 6,
		},
	]);
	assert.strictEqual(resolve4CallCount, 0);
});

test('DNS cache queries IPv4 records for V4MAPPED when IPv6 has no records', async _t => {
	const cache = new DnsCache({
		lookup: false,
		resolver: {
			resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			resolve6() {
				return [];
			},
		},
	});

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {
		all: true,
		family: 6,
		hints: V4MAPPED,
	}), [
		{
			address: '::ffff:127.0.0.1',
			family: 6,
		},
	]);
});

test.serial('DNS cache refreshes ADDRCONFIG interface state for each lookup', async _t => {
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

		await assert.rejects(cache.lookupAsync('example.com', {
			family: 6,
			hints: ADDRCONFIG,
		}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		assert.strictEqual(resolve6CallCount, 0);

		hasIpv6 = true;
		assert.deepStrictEqual(await cache.lookupAsync('example.com', {
			family: 6,
			hints: ADDRCONFIG,
		}), {
			address: '::1',
			family: 6,
		});
		assert.strictEqual(resolve6CallCount, 1);
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
});

test('DNS cache removes stale async cache set values cleared by hostname without a newer write', async _t => {
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

	assert.partialDeepStrictEqual(await firstLookup, {address: '127.0.0.1'});
	await setImmediate();
	assert.partialDeepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	assert.strictEqual(resolve4CallCount, 2);
});

test('DNS cache shares concurrent fallback lookups', async _t => {
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

	assert.deepStrictEqual(await Promise.all([firstLookup, secondLookup]), [
		{
			address: '127.0.0.1',
			family: 4,
		},
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);
	assert.strictEqual(lookupCallCount, 1);
});

test('DNS cache does not share concurrent fallback lookups with different result orders', async _t => {
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
				callback(null, options.order === 'ipv6first' ? entries.toReversed() : entries);
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

	assert.deepStrictEqual(await firstLookup, [
		{
			address: '127.0.0.1',
			family: 4,
		},
		{
			address: '::1',
			family: 6,
		},
	]);
	assert.deepStrictEqual(await secondLookup, [
		{
			address: '::1',
			family: 6,
		},
		{
			address: '127.0.0.1',
			family: 4,
		},
	]);
	assert.strictEqual(lookupCallCount, 2);
});

test('DNS cache propagates non-missing fallback lookup errors', async _t => {
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

	await assert.rejects(cache.lookupAsync('example.com', {family: 4}), {
		message: 'ESERVFAIL',
	});
});

test('DNS cache snapshots options when starting concurrent lookups', async _t => {
	const cache = new DnsCache({
		lookup: false,
		resolver: {
			async resolve4() {
				return [{address: '127.0.0.1', ttl: 60}];
			},
			async resolve6() {
				return [{address: '::1', ttl: 60}];
			},
		},
	});
	const options = {family: 4, all: false};
	const first = cache.lookupAsync('example.com', options);
	options.family = 6;
	options.all = true;
	const second = cache.lookupAsync('example.com', options);

	assert.deepStrictEqual(await Promise.all([first, second]), [
		{address: '127.0.0.1', family: 4},
		[{address: '::1', family: 6}],
	]);
});

for (const source of ['resolver', 'cache', 'literal']) {
	for (const all of [false, true]) {
		test(`DNS cache preserves all=${all} callback shape for ${source} results`, async _t => {
			const cache = new DnsCache({
				lookup: false,
				resolver: {
					async resolve4() {
						return [{address: '127.0.0.1', ttl: 60}];
					},
					async resolve6() {
						return [];
					},
				},
			});
			const hostname = source === 'literal' ? '127.0.0.1' : 'example.com';
			if (source === 'cache') {
				await cache.lookupAsync(hostname, {family: 4});
			}

			const options = {family: 4, all};
			const result = new Promise<unknown[]>(resolve => {
				cache.lookup(hostname, options, (...arguments_) => {
					resolve(arguments_);
				});
			});
			options.all = !all;

			assert.deepStrictEqual(await result, all
				? [null, [{address: '127.0.0.1', family: 4}]]
				: [null, '127.0.0.1', 4]);
		});
	}
}

test('DNS cache retains lookup options while waiting to use the fallback resolver', async _t => {
	const cache = new DnsCache({
		resolver: {
			async resolve4() {
				return [];
			},
			async resolve6() {
				return [];
			},
		},
		lookup(_hostname, options, callback) {
			assert.strictEqual(options.family, 4);
			assert.strictEqual(options.order, 'ipv4first');
			assert.strictEqual(options.all, true);
			callback(null, [{address: '127.0.0.1', family: 4}]);
		},
	});
	const options: LookupOptions = {family: 4, order: 'ipv4first'};
	const result = cache.lookupAsync('example.com', options);
	options.family = 6;
	options.order = 'ipv6first';

	assert.deepStrictEqual(await result, {address: '127.0.0.1', family: 4});
});

// A record without a usable TTL must not turn into a `NaN` expiry, which would keep the
// entry forever.
for (const [name, ttl] of [
	['a missing ttl', undefined],
	['a non-numeric ttl', 'soon' as unknown as number],
	['a negative ttl', -1],
] as Array<[string, number | undefined]>) {
	test(`DNS cache does not cache forever for a record with ${name}`, async _t => {
		let resolve4CallCount = 0;
		// The resolver type says a record always carries a numeric TTL, which is exactly what
		// these cases violate.
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const record = {address: '127.0.0.1', ttl} as {address: string; ttl: number};
		const cache = new DnsCache({
			resolver: createResolver({
				async resolve4() {
					resolve4CallCount++;
					return [record];
				},
			}),
		});

		await cache.lookupAsync('example.com', {family: 4});
		await cache.lookupAsync('example.com', {family: 4});

		assert.strictEqual(resolve4CallCount, 2);
	});
}

// A custom `lookup` is not `dns.lookup`, so it may ignore `all: true` and resolve with the
// single-result shape instead of an array.
test('DNS cache fallback accepts a lookup that ignores the all option', async _t => {
	const cache = new DnsCache({
		lookup: ((hostname: string, options: LookupOptions, callback: (error: Error | undefined, address: string, family: number) => void) => {
			assert.strictEqual(options.all, true);
			callback(undefined, hostname === 'example.com' ? '1.2.3.4' : '', 4);
		}) as unknown as LookupFunction,
		resolver: createResolver({}),
	});

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {family: 4}), {address: '1.2.3.4', family: 4});
});

test('DNS cache fallback reports the family of a single-result address', async _t => {
	const cache = new DnsCache({
		lookup: ((hostname: string, options: LookupOptions, callback: (error: Error | undefined, address: string, family: number) => void) => {
			assert.strictEqual(options.all, true);
			callback(undefined, hostname === 'example.com' ? '::1' : '', 6);
		}) as unknown as LookupFunction,
		resolver: createResolver({}),
	});

	assert.deepStrictEqual(await cache.lookupAsync('example.com', {family: 6}), {address: '::1', family: 6});
});

test('DNS cache surfaces the resolver error when both families reject', async _t => {
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				throw createDnsError('ESERVFAIL');
			},
			async resolve6() {
				throw createDnsError('E_REFUSED');
			},
		}),
	});

	const error = await cache.lookupAsync('example.com')
		.then(() => undefined)
		.catch((error: unknown): NodeJS.ErrnoException => error as NodeJS.ErrnoException);

	// Without a family filter both lookups run; a non-empty-result error must surface instead
	// of silently turning into an empty result.
	assert.strictEqual(error?.code, 'ESERVFAIL');
});
