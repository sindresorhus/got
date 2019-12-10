function validateSearchParams(searchParams: Record<string, unknown>): asserts searchParams is Record<string, string | number | boolean | null> {
	for (const value of Object.values(searchParams)) {
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
			throw new TypeError(`The \`searchParams\` value '${String(value)}' must be a string, number, boolean or null`);
		}
	}
}

export interface URLOptions {
	href?: string;
	origin?: string;
	protocol?: string;
	username?: string;
	password?: string;
	host?: string;
	hostname?: string;
	port?: string | number;
	pathname?: string;
	search?: string;
	searchParams?: Record<string, string | number | boolean | null> | URLSearchParams | string;
	hash?: string;

	// The only accepted legacy URL options
	path?: string;
}

const keys: Array<Exclude<keyof URLOptions, 'href' | 'origin' | 'searchParams' | 'path'>> = [
	'protocol',
	'username',
	'password',
	'host',
	'hostname',
	'port',
	'pathname',
	'search',
	'hash'
];

export default (options: URLOptions): URL => {
	let origin: string;

	if (options.path) {
		if (options.pathname) {
			throw new TypeError('Parameters `path` and `pathname` are mutually exclusive.');
		}

		if (options.search) {
			throw new TypeError('Parameters `path` and `search` are mutually exclusive.');
		}

		if (options.searchParams) {
			throw new TypeError('Parameters `path` and `searchParams` are mutually exclusive.');
		}
	}

	if (Reflect.has(options, 'auth')) {
		throw new TypeError('Parameter `auth` is deprecated. Use `username` / `password` instead.');
	}

	if (options.search && options.searchParams) {
		throw new TypeError('Parameters `search` and `searchParams` are mutually exclusive.');
	}

	if (options.href) {
		return new URL(options.href);
	}

	if (options.origin) {
		origin = options.origin;
	} else {
		if (!options.protocol) {
			throw new TypeError('No URL protocol specified');
		}

		origin = `${options.protocol}//${options.hostname ?? options.host ?? ''}`;
	}

	const url = new URL(origin);

	if (options.path) {
		const searchIndex = options.path.indexOf('?');
		if (searchIndex === -1) {
			options.pathname = options.path;
		} else {
			options.pathname = options.path.slice(0, searchIndex);
			options.search = options.path.slice(searchIndex + 1);
		}
	}

	if (Reflect.has(options, 'path')) {
		delete options.path;
	}

	for (const key of keys) {
		if (Reflect.has(options, key)) {
			url[key] = options[key].toString();
		}
	}

	if (options.searchParams) {
		if (typeof options.searchParams !== 'string' && !(options.searchParams instanceof URLSearchParams)) {
			validateSearchParams(options.searchParams);
		}

		(new URLSearchParams(options.searchParams as Record<string, string>)).forEach((value, key) => {
			url.searchParams.append(key, value);
		});
	}

	return url;
};
