// TODO: Remove this when https://github.com/DefinitelyTyped/DefinitelyTyped/issues/34960 is resolved
declare global {
	class URL {
		readonly origin: string;
		readonly searchParams: URLSearchParams;
		hash: string;
		host: string;
		hostname: string;
		href: string;
		password: string;
		pathname: string;
		port: string;
		protocol: string;
		search: string;
		username: string;

		constructor(input: string, base?: string | URL);
		toString(): string;
		toJSON(): string;
	}

	class URLSearchParams implements Iterable<[string, string]> {
		constructor(init?: URLSearchParams | string | {[key: string]: string | string[] | undefined} | Iterable<[string, string]> | Array<[string, string]>);
		append(name: string, value: string): void;
		delete(name: string): void;
		entries(): IterableIterator<[string, string]>;
		forEach(callback: (value: string, name: string, searchParams: this) => void): void;
		get(name: string): string | null;
		getAll(name: string): string[];
		has(name: string): boolean;
		keys(): IterableIterator<string>;
		set(name: string, value: string): void;
		sort(): void;
		toString(): string;
		values(): IterableIterator<string>;
		[Symbol.iterator](): IterableIterator<[string, string]>;
	}
}
