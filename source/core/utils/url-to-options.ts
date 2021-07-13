import {URL, UrlWithStringQuery} from 'url';
import is from '@sindresorhus/is';

// TODO: Deprecate legacy URL at some point

export interface LegacyUrlOptions {
	protocol: string;
	hostname: string;
	host: string;
	hash: string | null;
	search: string | null;
	pathname: string;
	href: string;
	path: string;
	port?: number;
	auth?: string;
}

export default function urlToOptions(url: URL | UrlWithStringQuery): LegacyUrlOptions {
	// Cast to URL
	url = url as URL;

	const options: LegacyUrlOptions = {
		protocol: url.protocol,
		hostname: is.string(url.hostname) && url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
		host: url.host,
		hash: url.hash,
		search: url.search,
		pathname: url.pathname,
		href: url.href,
		path: `${url.pathname || ''}${url.search || ''}`,
	};

	if (is.string(url.port) && url.port.length > 0) {
		options.port = Number(url.port);
	}

	if (url.username || url.password) {
		options.auth = `${url.username || ''}:${url.password || ''}`;
	}

	return options;
}
