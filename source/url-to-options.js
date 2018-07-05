'use strict';

// From: https://github.com/nodejs/node/blob/8476053c132fd9613aab547aba165190f8064254/lib/internal/url.js#L1318-L1340
module.exports = url => {
	const options = {
		protocol: url.protocol,
		hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
		hash: url.hash,
		search: url.search,
		pathname: url.pathname,
		path: `${url.pathname}${url.search}`,
		href: url.href
	};

	if (url.port !== '') {
		options.port = Number(url.port);
	}

	if (url.username || url.password) {
		options.auth = `${url.username}:${url.password}`;
	}

	return options;
};
