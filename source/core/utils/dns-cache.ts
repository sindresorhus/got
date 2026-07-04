import {
	ADDRCONFIG,
	ALL,
	V4MAPPED,
	lookup as dnsLookup,
	promises as dnsPromises,
} from 'node:dns';
import {isIP, type LookupFunction} from 'node:net';
import os from 'node:os';
import {promisify} from 'node:util';

type DnsFamily = 4 | 6;

type DnsLookupOptions = {
	all?: boolean;
	family?: number;
	hints?: number;
};

type DnsLookupCallback = Parameters<LookupFunction>[2];

type ResolverRecord = string | {
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
	ttl?: number;
};

type CachedFamily = {
	entries: DnsCacheEntry[];
	expires: number;
};

type MaybePromise<T> = T | Promise<T>;

type DnsCacheStore = {
	get(key: string): MaybePromise<CachedFamily | undefined>;
	set(key: string, value: CachedFamily): MaybePromise<unknown>;
	delete(key: string): unknown;
	clear(): unknown;
};

export type DnsCacheOptions = {
	cache?: DnsCacheStore;
	maxTtl?: number;
	fallbackDuration?: number;
	errorTtl?: number;
	resolver?: Resolver;
	lookup?: LookupFunction | false;
};

export type DnsCacheableLookup = {
	lookup: LookupFunction;
	clear?(hostname?: string): void;
};

const ttl = {ttl: true} as const;
const noResultErrorCodes = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);
const maximumCacheTtl = Math.floor(2_147_483_647 / 1000);
const supportsAllHint = typeof ALL === 'number';

const isPromiseLike = <T>(value: MaybePromise<T>): value is Promise<T> => typeof (value as Promise<T>)?.then === 'function';

const now = () => Date.now();

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
	if (typeof record === 'string') {
		return {
			address: record,
			family,
		};
	}

	const entryTtl = Math.min(record.ttl, maxTtl);

	return {
		address: record.address,
		family,
		ttl: entryTtl,
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

	return undefined;
};

const familiesFromOptions = (options: DnsLookupOptions): DnsFamily[] => {
	const family = familyFromOptions(options);

	if (family === 6 && hasFlag(options.hints, V4MAPPED)) {
		return [6, 4];
	}

	if (family !== undefined) {
		return [family];
	}

	return [4, 6];
};

const cacheKey = (hostname: string, family: DnsFamily) => `${hostname}:${family}`;

const shouldIgnoreResolveError = (error: NodeJS.ErrnoException) => error.code !== undefined && noResultErrorCodes.has(error.code);

const toLookupResult = ({address, family}: DnsCacheEntry): DnsLookupResult => ({
	address,
	family,
});

const lookupLiteral = (hostname: string): DnsLookupResult => ({
	address: hostname,
	family: isIP(hostname) as DnsFamily,
});

export default class DnsCache implements DnsCacheableLookup {
	readonly lookup: LookupFunction;

	readonly #cache: DnsCacheStore;
	readonly #resolver: Resolver;
	readonly #dnsLookupAsync?: (hostname: string, options: DnsLookupOptions) => Promise<any>;
	readonly #pending = new Map<string, Promise<DnsCacheEntry[]>>();
	readonly #hostnamesToFallback = new Map<string, number>();
	readonly #hostnamesWithoutFallback = new Map<string, number>();
	readonly #interfaceInfo = getInterfaceInfo();
	readonly #maxTtl: number;
	readonly #fallbackDuration: number;
	readonly #errorTtl: number;

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
		this.lookup = this.#lookup.bind(this) as LookupFunction;
	}

	async lookupAsync(hostname: string, options?: number | DnsLookupOptions): Promise<DnsLookupResult | DnsLookupResult[]> {
		const normalizedOptions = normalizeLookupOptions(options);

		if (isIP(hostname) !== 0) {
			const entries = [lookupLiteral(hostname)];
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
		if (hostname === undefined) {
			this.#cache.clear();
			this.#pending.clear();
			this.#hostnamesToFallback.clear();
			this.#hostnamesWithoutFallback.clear();
			return;
		}

		for (const family of [4, 6] as const) {
			this.#cache.delete(cacheKey(hostname, family));
			this.#pending.delete(cacheKey(hostname, family));
		}

		this.#hostnamesToFallback.delete(hostname);
		this.#hostnamesWithoutFallback.delete(hostname);
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
		try {
			const result = await this.lookupAsync(hostname, options);

			if (options.all) {
				callback(null, result as DnsLookupResult[]);
				return;
			}

			const entry = result as DnsLookupResult;
			callback(null, entry.address, entry.family);
		} catch (error: unknown) {
			const callbackWithError = callback as (error: NodeJS.ErrnoException) => void;
			callbackWithError(error as NodeJS.ErrnoException);
		}
	}

	async #query(hostname: string, options: DnsLookupOptions): Promise<DnsCacheEntry[]> {
		if (this.#isInFallback(hostname)) {
			return this.#fallbackLookup(hostname, options);
		}

		const families = familiesFromOptions(options);
		const entries = await Promise.all(families.map(async family => this.#queryFamily(hostname, family)));
		const flattenedEntries = entries.flat();

		if (flattenedEntries.length > 0 || this.#dnsLookupAsync === undefined) {
			return flattenedEntries;
		}

		if (this.#isWithoutFallback(hostname)) {
			return [];
		}

		const fallbackEntries = await this.#fallbackLookup(hostname, options);

		if (fallbackEntries.length > 0 && this.#fallbackDuration > 0) {
			this.#hostnamesToFallback.set(hostname, now() + (this.#fallbackDuration * 1000));
		} else if (fallbackEntries.length === 0 && this.#errorTtl > 0) {
			this.#hostnamesWithoutFallback.set(hostname, now() + (this.#errorTtl * 1000));
		}

		return fallbackEntries;
	}

	async #queryFamily(hostname: string, family: DnsFamily): Promise<DnsCacheEntry[]> {
		const key = cacheKey(hostname, family);
		const cached = await this.#getCachedFamily(key);

		if (cached !== undefined) {
			return cached.entries;
		}

		const pending = this.#pending.get(key);

		if (pending !== undefined) {
			return pending;
		}

		const promise = this.#resolveAndCache(hostname, family);
		this.#pending.set(key, promise);

		try {
			return await promise;
		} finally {
			this.#pending.delete(key);
		}
	}

	async #getCachedFamily(key: string): Promise<CachedFamily | undefined> {
		let cached = this.#cache.get(key);

		if (isPromiseLike(cached)) {
			cached = await cached;
		}

		if (cached === undefined) {
			return undefined;
		}

		if (cached.expires <= now()) {
			this.#cache.delete(key);
			return undefined;
		}

		return cached;
	}

	async #resolveAndCache(hostname: string, family: DnsFamily): Promise<DnsCacheEntry[]> {
		const entries = await this.#resolveFamily(hostname, family);
		const expires = this.#expiresFor(entries);

		if (expires !== undefined) {
			await this.#cache.set(cacheKey(hostname, family), {
				entries,
				expires,
			});
		} else if (entries.length === 0 && this.#errorTtl > 0) {
			await this.#cache.set(cacheKey(hostname, family), {
				entries,
				expires: now() + (this.#errorTtl * 1000),
			});
		}

		return entries;
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
		const family = familyFromOptions(options);

		if (family === 6) {
			const ipv6Entries = entries.filter(entry => entry.family === 6);

			if (hasFlag(options.hints, V4MAPPED)) {
				entries = (supportsAllHint && hasFlag(options.hints, ALL)) || ipv6Entries.length === 0
					? map4To6(entries)
					: ipv6Entries;
			} else {
				entries = ipv6Entries;
			}
		} else if (family === 4) {
			entries = entries.filter(entry => entry.family === 4);
		}

		if (hasFlag(options.hints, ADDRCONFIG)) {
			entries = entries.filter(entry => entry.family === 6 ? this.#interfaceInfo.has6 : this.#interfaceInfo.has4);
		}

		return entries;
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

	#isInFallback(hostname: string): boolean {
		const expires = this.#hostnamesToFallback.get(hostname);

		if (expires === undefined) {
			return false;
		}

		if (expires <= now()) {
			this.#hostnamesToFallback.delete(hostname);
			return false;
		}

		return true;
	}

	#isWithoutFallback(hostname: string): boolean {
		const expires = this.#hostnamesWithoutFallback.get(hostname);

		if (expires === undefined) {
			return false;
		}

		if (expires <= now()) {
			this.#hostnamesWithoutFallback.delete(hostname);
			return false;
		}

		return true;
	}
}
