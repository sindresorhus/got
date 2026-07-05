import {
	ADDRCONFIG,
	ALL,
	V4MAPPED,
	getDefaultResultOrder,
	lookup as dnsLookup,
	promises as dnsPromises,
	type LookupOptions,
} from 'node:dns';
import {isIP, type LookupFunction} from 'node:net';
import os from 'node:os';
import {promisify} from 'node:util';

type DnsFamily = 4 | 6;

type DnsLookupOptions = Omit<LookupOptions, 'verbatim'> & {
	verbatim?: boolean;
};

type DnsLookupCallback = Parameters<LookupFunction>[2];
type DnsLookupOrder = ReturnType<typeof getDefaultResultOrder>;

type ResolverRecord = {
	address: string;
	ttl: number;
};

type Resolver = {
	resolve4(hostname: string, options: {ttl: true}): Promise<ResolverRecord[]> | ResolverRecord[];
	resolve6(hostname: string, options: {ttl: true}): Promise<ResolverRecord[]> | ResolverRecord[];
};

type DnsLookupResult = {
	address: string;
	family: DnsFamily;
};

type DnsCacheEntry = DnsLookupResult & {
	expires?: number;
};

type CachedFamily = {
	entries: DnsCacheEntry[];
	expires: number;
	clearVersion: number;
};

type MaybePromise<T> = T | Promise<T>;

type DnsCacheStore = {
	get(key: string): MaybePromise<CachedFamily | undefined>;
	set(key: string, value: CachedFamily): MaybePromise<unknown>;
	delete(key: string): boolean;
};

export type DnsCacheOptions = {
	cache?: DnsCacheStore;
	maxTtl?: number;
	fallbackDuration?: number;
	errorTtl?: number;
	resolver?: Resolver;
	lookup?: LookupFunction | false;
};

export type DnsCacheLookup = {
	lookup: LookupFunction;
	clear?(hostname?: string): void;
};

const ttl = {ttl: true} as const;
const noResultErrorCodes = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);
const maximumCacheTtl = Math.floor(2_147_483_647 / 1000);

const isPromiseLike = <T>(value: MaybePromise<T>): value is Promise<T> => typeof (value as Promise<T>)?.then === 'function';

const now = () => Date.now();

const hasUnexpired = (cache: Map<string, number>, key: string) => {
	const expires = cache.get(key);

	if (expires === undefined) {
		return false;
	}

	if (expires <= now()) {
		cache.delete(key);
		return false;
	}

	return true;
};

// eslint-disable-next-line no-bitwise
const hasFlag = (value: number | undefined, flag: number) => value !== undefined && (value & flag) === flag;

const getInterfaceInfo = () => {
	let has4 = false;
	let has6 = false;

	for (const networkInterface of Object.values(os.networkInterfaces())) {
		if (networkInterface === undefined) {
			continue;
		}

		for (const address of networkInterface) {
			if (address.internal) {
				continue;
			}

			if (address.family === 'IPv6') {
				has6 = true;
			} else {
				has4 = true;
			}

			if (has4 && has6) {
				return {has4, has6};
			}
		}
	}

	return {has4, has6};
};

const createNoResultError = (hostname: string): NodeJS.ErrnoException => {
	const error = new Error(`DNS cache lookup ENOTFOUND ${hostname}`) as NodeJS.ErrnoException & {hostname: string};
	error.code = 'ENOTFOUND';
	error.hostname = hostname;
	return error;
};

const normalizeLookupOptions = (options: number | DnsLookupOptions | undefined): DnsLookupOptions => {
	if (typeof options === 'number') {
		return {family: options};
	}

	return options ?? {};
};

const normalizeResolverRecord = (record: ResolverRecord, family: DnsFamily, maxTtl: number): DnsCacheEntry => {
	const entryTtl = Math.min(record.ttl, maxTtl);

	return {
		address: record.address,
		family,
		expires: now() + (entryTtl * 1000),
	};
};

const map4To6 = (entries: DnsCacheEntry[]): DnsCacheEntry[] => entries.map(entry => {
	if (entry.family === 6) {
		return entry;
	}

	return {
		...entry,
		address: `::ffff:${entry.address}`,
		family: 6,
	};
});

const familyFromOptions = (options: DnsLookupOptions): DnsFamily | undefined => {
	if (options.family === 4 || options.family === 6) {
		return options.family;
	}

	if (options.family === 'IPv4') {
		return 4;
	}

	if (options.family === 'IPv6') {
		return 6;
	}

	return undefined;
};

const orderFromOptions = (options: DnsLookupOptions): DnsLookupOrder => {
	if (options.order !== undefined) {
		return options.order;
	}

	if (options.verbatim !== undefined) {
		return options.verbatim ? 'verbatim' : 'ipv4first';
	}

	return getDefaultResultOrder();
};

const familiesFromOptions = (options: DnsLookupOptions): DnsFamily[] => {
	const family = familyFromOptions(options);

	if (family === 6 && hasFlag(options.hints, V4MAPPED)) {
		return [6, 4];
	}

	if (family !== undefined) {
		return [family];
	}

	if (orderFromOptions(options) === 'ipv6first') {
		return [6, 4];
	}

	return [4, 6];
};

const filterFamiliesByAddrConfig = (families: DnsFamily[], options: DnsLookupOptions): DnsFamily[] => {
	if (!hasFlag(options.hints, ADDRCONFIG)) {
		return families;
	}

	const interfaceInfo = getInterfaceInfo();
	return families.filter(family => family === 6 ? interfaceInfo.has6 : interfaceInfo.has4);
};

const cacheKey = (hostname: string, family: DnsFamily) => `${hostname}:${family}`;

const lookupOptionsKey = (hostname: string, options: DnsLookupOptions) => `${hostname}:${familyFromOptions(options) ?? 0}:${options.hints ?? 0}:${orderFromOptions(options)}`;

const shouldIgnoreResolveError = (error: NodeJS.ErrnoException) => error.code !== undefined && noResultErrorCodes.has(error.code);

const toLookupResult = ({address, family}: DnsCacheEntry): DnsLookupResult => ({
	address,
	family,
});

export default class DnsCache implements DnsCacheLookup {
	readonly lookup: LookupFunction;

	readonly #cache: DnsCacheStore;
	readonly #resolver: Resolver;
	readonly #dnsLookupAsync?: (hostname: string, options: DnsLookupOptions) => Promise<any>;
	readonly #cacheKeys = new Set<string>();
	readonly #pending = new Map<string, Promise<DnsCacheEntry[]>>();
	readonly #pendingFallback = new Map<string, Promise<DnsCacheEntry[]>>();
	readonly #lookupOptionsToFallback = new Map<string, number>();
	readonly #lookupOptionsWithoutFallback = new Map<string, number>();
	readonly #maxTtl: number;
	readonly #fallbackDuration: number;
	readonly #errorTtl: number;
	readonly #minimumVersionByHostname = new Map<string, number>();
	readonly #activeQueriesByHostname = new Map<string, number>();
	#minimumVersion = 0;
	#clearVersion = 0;

	constructor({
		cache = new Map<string, CachedFamily>(),
		maxTtl = maximumCacheTtl,
		fallbackDuration = 3600,
		errorTtl = 0.15,
		resolver = new dnsPromises.Resolver(),
		lookup = dnsLookup,
	}: DnsCacheOptions = {}) {
		this.#cache = cache;
		this.#resolver = resolver;
		this.#maxTtl = Math.min(maxTtl, maximumCacheTtl);
		this.#fallbackDuration = fallbackDuration;
		this.#errorTtl = errorTtl;
		this.#dnsLookupAsync = lookup === false ? undefined : promisify(lookup);
		this.lookup = this.#lookup.bind(this);
	}

	async lookupAsync(hostname: string, options?: number | DnsLookupOptions): Promise<DnsLookupResult | DnsLookupResult[]> {
		const normalizedOptions = normalizeLookupOptions(options);
		const literalFamily = isIP(hostname) as DnsFamily | 0;

		if (literalFamily !== 0) {
			const entries = [{
				address: hostname,
				family: literalFamily,
			}];
			return normalizedOptions.all ? entries : entries[0]!;
		}

		let entries = await this.#query(hostname, normalizedOptions);
		entries = this.#filterEntries(entries, normalizedOptions);

		if (entries.length === 0) {
			throw createNoResultError(hostname);
		}

		const lookupResults = entries.map(entry => toLookupResult(entry));

		return normalizedOptions.all ? lookupResults : lookupResults[0]!;
	}

	clear(hostname?: string): void {
		this.#clearVersion++;

		if (hostname === undefined) {
			this.#minimumVersion = this.#clearVersion;
			this.#minimumVersionByHostname.clear();
			for (const key of this.#cacheKeys) {
				this.#cache.delete(key);
			}

			this.#cacheKeys.clear();
			this.#pending.clear();
			this.#pendingFallback.clear();
			this.#lookupOptionsToFallback.clear();
			this.#lookupOptionsWithoutFallback.clear();
			return;
		}

		for (const family of [4, 6] as const) {
			const key = cacheKey(hostname, family);
			this.#cache.delete(key);
			this.#cacheKeys.delete(key);
			this.#pending.delete(key);
		}

		if (this.#activeQueriesByHostname.has(hostname)) {
			this.#minimumVersionByHostname.set(hostname, this.#clearVersion);
		}

		for (const key of this.#pendingFallback.keys()) {
			if (key.startsWith(`${hostname}:`)) {
				this.#pendingFallback.delete(key);
			}
		}

		for (const key of this.#lookupOptionsToFallback.keys()) {
			if (key.startsWith(`${hostname}:`)) {
				this.#lookupOptionsToFallback.delete(key);
			}
		}

		for (const key of this.#lookupOptionsWithoutFallback.keys()) {
			if (key.startsWith(`${hostname}:`)) {
				this.#lookupOptionsWithoutFallback.delete(key);
			}
		}
	}

	#lookup(hostname: string, options: number | DnsLookupOptions | DnsLookupCallback, callback?: DnsLookupCallback): void {
		if (typeof options === 'function') {
			callback = options;
			options = {};
		}

		if (callback === undefined) {
			throw new Error('Callback must be a function.');
		}

		const normalizedOptions = normalizeLookupOptions(options);

		void this.#lookupAndCallback(hostname, normalizedOptions, callback);
	}

	async #lookupAndCallback(hostname: string, options: DnsLookupOptions, callback: DnsLookupCallback): Promise<void> {
		let result: DnsLookupResult | DnsLookupResult[];

		try {
			result = await this.lookupAsync(hostname, options);
		} catch (error: unknown) {
			queueMicrotask(() => {
				const callbackWithError = callback as (error: NodeJS.ErrnoException) => void;
				callbackWithError(error as NodeJS.ErrnoException);
			});

			return;
		}

		queueMicrotask(() => {
			if (options.all) {
				callback(null, result as DnsLookupResult[]);
				return;
			}

			const entry = result as DnsLookupResult;
			callback(null, entry.address, entry.family);
		});
	}

	async #query(hostname: string, options: DnsLookupOptions): Promise<DnsCacheEntry[]> {
		this.#activeQueriesByHostname.set(hostname, (this.#activeQueriesByHostname.get(hostname) ?? 0) + 1);

		try {
			const lookupOptionKey = lookupOptionsKey(hostname, options);

			if (hasUnexpired(this.#lookupOptionsToFallback, lookupOptionKey)) {
				return await this.#fallbackLookupOnce(hostname, options, lookupOptionKey);
			}

			const families = filterFamiliesByAddrConfig(familiesFromOptions(options), options);
			const clearVersion = this.#clearVersion;
			const flattenedEntries = await this.#queryFamilies(hostname, families, clearVersion);

			if (flattenedEntries.length > 0 || this.#dnsLookupAsync === undefined) {
				return flattenedEntries;
			}

			if (hasUnexpired(this.#lookupOptionsWithoutFallback, lookupOptionKey)) {
				return [];
			}

			const fallbackEntries = await this.#fallbackLookupOnce(hostname, options, lookupOptionKey);

			if (!this.#isVersionCurrent(hostname, clearVersion)) {
				return fallbackEntries;
			}

			if (fallbackEntries.length > 0 && this.#fallbackDuration > 0) {
				this.#lookupOptionsToFallback.set(lookupOptionKey, now() + (this.#fallbackDuration * 1000));
			} else if (fallbackEntries.length === 0 && this.#errorTtl > 0) {
				this.#lookupOptionsWithoutFallback.set(lookupOptionKey, now() + (this.#errorTtl * 1000));
			}

			return fallbackEntries;
		} finally {
			this.#finishQuery(hostname);
		}
	}

	#finishQuery(hostname: string): void {
		const activeQueryCount = this.#activeQueriesByHostname.get(hostname);

		if (activeQueryCount === undefined) {
			return;
		}

		if (activeQueryCount > 1) {
			this.#activeQueriesByHostname.set(hostname, activeQueryCount - 1);
			return;
		}

		this.#activeQueriesByHostname.delete(hostname);
		this.#minimumVersionByHostname.delete(hostname);
	}

	async #queryFamilies(hostname: string, families: DnsFamily[], clearVersion: number): Promise<DnsCacheEntry[]> {
		if (families.length === 1) {
			return this.#queryFamily(hostname, families[0]!, clearVersion);
		}

		const results = await Promise.allSettled(families.map(family => this.#queryFamily(hostname, family, clearVersion)));
		const entries = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);

		if (entries.length > 0) {
			return entries;
		}

		const rejected = results.find(result => result.status === 'rejected');

		if (rejected !== undefined) {
			if (rejected.reason instanceof Error) {
				throw rejected.reason;
			}

			throw new Error(String(rejected.reason));
		}

		return [];
	}

	async #queryFamily(hostname: string, family: DnsFamily, clearVersion: number): Promise<DnsCacheEntry[]> {
		const key = cacheKey(hostname, family);
		const cached = await this.#getCachedFamily(key, hostname);

		if (cached !== undefined) {
			return cached.entries;
		}

		if (!this.#isVersionCurrent(hostname, clearVersion)) {
			return this.#resolveAndCache(hostname, family, clearVersion);
		}

		const pending = this.#pending.get(key);

		if (pending !== undefined) {
			return pending;
		}

		const promise = this.#resolveAndCache(hostname, family, clearVersion);
		this.#pending.set(key, promise);

		try {
			return await promise;
		} finally {
			if (this.#pending.get(key) === promise) {
				this.#pending.delete(key);
			}
		}
	}

	async #getCachedFamily(key: string, hostname: string): Promise<CachedFamily | undefined> {
		let cached = this.#cache.get(key);

		if (isPromiseLike(cached)) {
			cached = await cached;
		}

		if (cached === undefined) {
			return undefined;
		}

		if (!this.#isVersionCurrent(hostname, cached.clearVersion)) {
			return undefined;
		}

		if (cached.expires <= now()) {
			this.#cache.delete(key);
			this.#cacheKeys.delete(key);
			return undefined;
		}

		return cached;
	}

	async #resolveAndCache(hostname: string, family: DnsFamily, clearVersion: number): Promise<DnsCacheEntry[]> {
		const entries = await this.#resolveFamily(hostname, family);
		const expires = this.#expiresFor(entries);
		const key = cacheKey(hostname, family);

		if (!this.#isVersionCurrent(hostname, clearVersion)) {
			return entries;
		}

		if (expires !== undefined) {
			await this.#setCachedFamily(key, hostname, {
				entries,
				expires,
			}, clearVersion);
		} else if (entries.length === 0 && this.#errorTtl > 0) {
			await this.#setCachedFamily(key, hostname, {
				entries,
				expires: now() + (this.#errorTtl * 1000),
			}, clearVersion);
		}

		return entries;
	}

	async #setCachedFamily(key: string, hostname: string, cached: Omit<CachedFamily, 'clearVersion'>, clearVersion: number): Promise<void> {
		if (!this.#isVersionCurrent(hostname, clearVersion)) {
			return;
		}

		await this.#deleteExpiredCacheEntries();

		await this.#cache.set(key, {
			...cached,
			clearVersion,
		});
		this.#cacheKeys.add(key);

		if (this.#isVersionCurrent(hostname, clearVersion)) {
			return;
		}

		let current = this.#cache.get(key);

		if (isPromiseLike(current)) {
			current = await current;
		}

		if (current?.clearVersion === clearVersion && !this.#isVersionCurrent(hostname, current.clearVersion)) {
			this.#cache.delete(key);
			this.#cacheKeys.delete(key);
		}
	}

	async #deleteExpiredCacheEntries(): Promise<void> {
		const time = now();
		await Promise.all([...this.#cacheKeys].map(async key => this.#deleteExpiredCacheEntry(key, time)));
	}

	async #deleteExpiredCacheEntry(key: string, time: number): Promise<void> {
		let cached = this.#cache.get(key);

		if (isPromiseLike(cached)) {
			cached = await cached;
		}

		if (cached === undefined) {
			this.#cacheKeys.delete(key);
			return;
		}

		if (cached.expires > time) {
			return;
		}

		let current = this.#cache.get(key);

		if (isPromiseLike(current)) {
			current = await current;
		}

		if (current?.clearVersion === cached.clearVersion && current.expires === cached.expires) {
			this.#cache.delete(key);
			this.#cacheKeys.delete(key);
		}
	}

	#isVersionCurrent(hostname: string, clearVersion: number): boolean {
		const minimumVersion = this.#minimumVersionByHostname.get(hostname) ?? this.#minimumVersion;
		return clearVersion >= minimumVersion;
	}

	async #resolveFamily(hostname: string, family: DnsFamily): Promise<DnsCacheEntry[]> {
		try {
			const records = family === 4
				? await this.#resolver.resolve4(hostname, ttl)
				: await this.#resolver.resolve6(hostname, ttl);

			return records.map(record => normalizeResolverRecord(record, family, this.#maxTtl));
		} catch (error: unknown) {
			if (shouldIgnoreResolveError(error as NodeJS.ErrnoException)) {
				return [];
			}

			throw error;
		}
	}

	#expiresFor(entries: DnsCacheEntry[]): number | undefined {
		let expires = Number.POSITIVE_INFINITY;

		for (const entry of entries) {
			if (entry.expires === undefined) {
				continue;
			}

			expires = Math.min(expires, entry.expires);
		}

		return expires === Number.POSITIVE_INFINITY ? undefined : expires;
	}

	#filterEntries(entries: DnsCacheEntry[], options: DnsLookupOptions): DnsCacheEntry[] {
		if (hasFlag(options.hints, ADDRCONFIG)) {
			const interfaceInfo = getInterfaceInfo();
			entries = entries.filter(entry => entry.family === 6 ? interfaceInfo.has6 : interfaceInfo.has4);
		}

		const family = familyFromOptions(options);

		if (family === 6) {
			const ipv6Entries = entries.filter(entry => entry.family === 6);

			if (hasFlag(options.hints, V4MAPPED)) {
				entries = hasFlag(options.hints, ALL) || ipv6Entries.length === 0
					? map4To6(entries)
					: ipv6Entries;
			} else {
				entries = ipv6Entries;
			}
		} else if (family === 4) {
			entries = entries.filter(entry => entry.family === 4);
		}

		return entries;
	}

	async #fallbackLookupOnce(hostname: string, options: DnsLookupOptions, key: string): Promise<DnsCacheEntry[]> {
		const pending = this.#pendingFallback.get(key);

		if (pending !== undefined) {
			return pending;
		}

		const promise = this.#fallbackLookup(hostname, options);
		this.#pendingFallback.set(key, promise);

		try {
			return await promise;
		} finally {
			if (this.#pendingFallback.get(key) === promise) {
				this.#pendingFallback.delete(key);
			}
		}
	}

	async #fallbackLookup(hostname: string, options: DnsLookupOptions): Promise<DnsCacheEntry[]> {
		if (this.#dnsLookupAsync === undefined) {
			return [];
		}

		let entries: Array<{address: string; family: DnsFamily}>;

		try {
			entries = await this.#dnsLookupAsync(hostname, {
				...options,
				all: true,
			}) as Array<{address: string; family: DnsFamily}>;
		} catch (error: unknown) {
			if (shouldIgnoreResolveError(error as NodeJS.ErrnoException)) {
				return [];
			}

			throw error;
		}

		return entries.map(entry => ({
			address: entry.address,
			family: entry.family,
		}));
	}
}
