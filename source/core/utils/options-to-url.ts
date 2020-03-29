/* istanbul ignore file: deprecated */
import {URL} from 'url';

export interface URLOptions {
	href?: string;
	protocol?: string;
	host?: string;
	hostname?: string;
	port?: string | number;
	pathname?: string;
	search?: string;
	searchParams?: unknown;
	path?: string;
}

const keys: Array<Exclude<keyof URLOptions, 'searchParams' | 'path'>> = [
	'protocol',
	'host',
	'hostname',
	'port',
	'pathname',
	'search'
];

export default (origin: string, options: URLOptions): URL => {
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

	if (options.search && options.searchParams) {
		throw new TypeError('Parameters `search` and `searchParams` are mutually exclusive.');
	}

	if (!origin) {
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

		delete options.path;
	}

	for (const key of keys) {
		if (options[key]) {
			url[key] = options[key]!.toString();
		}
	}

	return url;
};
