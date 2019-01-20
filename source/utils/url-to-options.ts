import is from '@sindresorhus/is';
import {URL} from 'url';

export interface URLOptions {
	protocol: string,
	hostname: string,
	host: string,
	hash: string,
	search: string,
	pathname: string,
	href: string,
	path: string,
	port?: number
	auth?: string
}

export default (url: URL): URLOptions => {
	const options: URLOptions = {
		protocol: url.protocol,
		hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
		host: url.host,
		hash: url.hash,
		search: url.search,
		pathname: url.pathname,
		href: url.href,
		path: `${url.pathname}${url.search}`
	};

	if (is.string(url.port) && url.port.length > 0) {
		options.port = Number(url.port);
	}

	if (url.username || url.password) {
		options.auth = `${url.username}:${url.password}`;
	}

	return options;
};
