import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
import {
	ADDRCONFIG,
	getDefaultResultOrder,
	setDefaultResultOrder,
	V4MAPPED,
} from 'node:dns';
import process from 'node:process';
import {setImmediate} from 'node:timers/promises';
import type {LookupFunction} from 'node:net';
import os from 'node:os';
import {promisify} from 'node:util';
import FakeTimers from '@sinonjs/fake-timers';
import test from 'ava';
import DnsCache from '../source/core/utils/dns-cache.js';

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

	const result = await cache.lookupAsync('example.com', {family: 'IPv6'});

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

test('DNS cache supports lookup result order', async t => {
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

	t.deepEqual(await cache.lookupAsync('example.com', {
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

	t.deepEqual(await cache.lookupAsync('example.com', {
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

test.serial('DNS cache uses the default DNS result order', async t => {
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

		t.deepEqual(await cache.lookupAsync('example.com', {all: true}), [
			{
				address: '::1',
				family: 6,
			},
			{
				address: '127.0.0.1',
				family: 4,
			},
		]);
		t.deepEqual(await cache.lookupAsync('example.com', {
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

test('DNS cache handles IP literals without resolver lookups', async t => {
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

test('DNS cache passes resolver errors to lookup callbacks', async t => {
	const cache = new DnsCache({
		resolver: createResolver({
			async resolve4() {
				throw createDnsError('ESERVFAIL');
			},
		}),
	});

	await new Promise<void>(resolve => {
		cache.lookup('example.com', {family: 4}, error => {
			t.is(error?.code, 'ESERVFAIL');
			resolve();
		});
	});
});

test('DNS cache does not call callbacks twice when callbacks throw', async t => {
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

	t.is(stdout.trim(), '1');
});

test('DNS cache does not call error callbacks twice when callbacks throw', async t => {
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

	t.is(stdout.trim(), '1');
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

test.serial('DNS cache applies ADDRCONFIG before V4MAPPED filtering', async t => {
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

		t.deepEqual(result, {
			address: '::ffff:127.0.0.1',
			family: 6,
		});
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
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

		t.deepEqual(result, [
			{
				address: '127.0.0.1',
				family: 4,
			},
		]);
		t.is(resolve6CallCount, 0);
	} finally {
		os.networkInterfaces = originalNetworkInterfaces;
	}
});

test('DNS cache clears one hostname', async t => {
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

	t.is(resolve4CallCount, 2);
});

test('DNS cache keeps other hostnames cached when one hostname is cleared', async t => {
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

	t.like(await cache.lookupAsync('example.net', {family: 4}), {address: '127.0.0.2'});
	t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.1'});
	t.is(resolveCallCounts.get('example.com'), 2);
	t.is(resolveCallCounts.get('example.net'), 1);
});

test('DNS cache caches in-flight lookups for other hostnames when one hostname is cleared', async t => {
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

	t.like(await lookup, {address: '127.0.0.2'});
	t.like(await cache.lookupAsync('example.net', {family: 4}), {address: '127.0.0.2'});
	t.is(resolveCallCounts.get('example.com'), undefined);
	t.is(resolveCallCounts.get('example.net'), 1);
});

test('DNS cache does not cache in-flight lookups cleared by hostname', async t => {
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

	t.is(resolve4CallCount, 2);

	pendingResolvers[1]!();

	t.like(await firstLookup, {address: '127.0.0.1'});
	t.like(await secondLookup, {address: '127.0.0.2'});
	t.like(await thirdLookup, {address: '127.0.0.2'});

	await cache.lookupAsync('example.com', {family: 4});

	t.is(resolve4CallCount, 2);
});

test('DNS cache ignores async cache get results cleared by hostname', async t => {
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

	t.like(await lookup, {address: '127.0.0.2'});
	t.is(resolve4CallCount, 1);
});

test('DNS cache does not publish stale pending lookups after async cache gets cleared by hostname', async t => {
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

	t.is(resolve4CallCount, 2);

	pendingResolvers[0]!();
	pendingResolvers[1]!();

	t.like(await firstLookup, {address: '127.0.0.1'});
	t.like(await secondLookup, {address: '127.0.0.2'});
	t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	t.is(resolve4CallCount, 2);
});

test('DNS cache ignores stale async cache set values cleared by hostname', async t => {
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

	t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	resolveSet();
	t.like(await firstLookup, {address: '127.0.0.1'});
	t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
	t.is(resolve4CallCount, 2);
});

test('DNS cache clears fallback state for one hostname', async t => {
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

	t.is(resolve4CallCount, 2);
	t.is(lookupCallCount, 2);
});

test('DNS cache caches fallback state for other hostnames when one hostname is cleared', async t => {
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

	t.like(await lookup, {address: '127.0.0.1'});

	const secondLookup = cache.lookupAsync('example.net', {family: 4});
	await setImmediate();
	resolveLookup();

	t.like(await secondLookup, {address: '127.0.0.1'});
	t.is(resolve4CallCount, 1);
	t.is(lookupCallCount, 2);
});

test('DNS cache does not cache fallback state cleared by hostname', async t => {
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

	t.like(await lookup, {address: '127.0.0.1'});

	const secondLookup = cache.lookupAsync('example.com', {family: 4});
	await setImmediate();
	resolveLookup();

	t.like(await secondLookup, {address: '127.0.0.1'});
	t.is(resolve4CallCount, 2);
	t.is(lookupCallCount, 2);
});

test('DNS cache clears all hostnames', async t => {
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

	t.is(resolve4CallCount, 4);
});

test('DNS cache does not cache in-flight lookups cleared by clearing all hostnames', async t => {
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

	t.is(resolve4CallCount, 2);

	pendingResolvers[1]!();

	t.like(await firstLookup, {address: '127.0.0.1'});
	t.like(await secondLookup, {address: '127.0.0.2'});
	t.like(await thirdLookup, {address: '127.0.0.2'});

	t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});

	t.is(resolve4CallCount, 2);
});

test('DNS cache clears missing fallback state for one hostname', async t => {
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

	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});
	cache.clear('example.com');
	await t.throwsAsync(cache.lookupAsync('example.com', {family: 4}), {
		message: 'DNS cache lookup ENOTFOUND example.com',
	});

	t.is(lookupCallCount, 2);
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

test.serial('DNS cache purges expired entries lazily on write', async t => {
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
		t.true(store.has('example.com:4'));

		clock.tick(1001);
		await cache.lookupAsync('example.net', {family: 4});

		t.false(store.has('example.com:4'));
		t.true(store.has('example.net:4'));
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache purges expired async cache entries lazily on write', async t => {
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
		t.true(store.has('example.com:4'));

		clock.tick(1001);
		await cache.lookupAsync('example.net', {family: 4});

		t.false(store.has('example.com:4'));
		t.true(store.has('example.net:4'));
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache caps large TTLs and expires them lazily without timers', async t => {
	const clock = FakeTimers.install({
		now: 0,
		toFake: ['Date'],
	});
	const originalSetTimeout = globalThis.setTimeout;
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

		t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.1'});
		clock.tick(2_147_482_999);
		t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.1'});
		clock.tick(1);
		t.like(await cache.lookupAsync('example.com', {family: 4}), {address: '127.0.0.2'});
		t.is(resolve4CallCount, 2);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		clock.uninstall();
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

test('DNS cache supports async cache reads and writes', async t => {
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

test.serial('DNS cache normalizes string family aliases for missing fallback lookups', async t => {
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

		await t.throwsAsync(cache.lookupAsync('example.com', {family: 'IPv6'}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await t.throwsAsync(cache.lookupAsync('example.com', {family: 6}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		t.is(resolve6CallCount, 1);
		t.is(lookupCallCount, 1);
	} finally {
		clock.uninstall();
	}
});

test.serial('DNS cache negative-caches missing fallback lookups per option set', async t => {
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

		await t.throwsAsync(cache.lookupAsync('example.com', {family: 6}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});
		await t.throwsAsync(cache.lookupAsync('example.com', {family: 6}), {
			message: 'DNS cache lookup ENOTFOUND example.com',
		});

		t.like(await cache.lookupAsync('example.com', {family: 4}), {
			address: '127.0.0.1',
			family: 4,
		});
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

test('DNS cache uses successful family results when another family fails', async t => {
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
	t.deepEqual(result, {address: '127.0.0.1', family: 4});
	t.is(resolve6CallCount, 1);
	t.deepEqual(await cache.lookupAsync('example.net', {all: true, order: 'ipv6first'}), [{address: '127.0.0.1', family: 4}]);
	t.is(resolve6CallCount, 2);
});
