'use strict';

const ProxyAgent = require('proxy-agent');

module.exports = function (url) {
	const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
	const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';

	if (httpProxy && !noProxy.split(',').find(value => url.hostname === value) && url.hostname !== 'unix') {
		return new ProxyAgent(httpProxy);
	}
};
