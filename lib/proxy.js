'use strict';

const ProxyAgent = require('proxy-agent');
const ip = require('ip');

function validate(noProxy, url) {
	if (noProxy === '') {
		return true;
	}
	return noProxy.split(',').some(value => {
		// If the host is equal to an entry on no_proxy return false
		if (url.host === value) {
			return false;
		}
		// Test for IPv6 - never use a proxy
		if (value.split(':').length > 2) {
			return false;
		}
		// Test for no ports on hostname
		if (value.split(':').length === 1 && url.hostname === value) {
			return false;
		}
		// Test for subnets on hosts in IP format
		if (value.split('/')[0].match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/) && url.hostname.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/) && ip.cidrSubnet(`${value.split('/')[0]}/${value.split('/')[1] ? value.split('/')[1] : 32}`).contains(url.hostname)) {
			return false;
		}
		return true;
	});
}

function getProxyFromProtocol(url) {
	if (url.protocol === 'https:') {
		return process.env.HTTPS_PROXY ||
           process.env.https_proxy ||
           process.env.HTTP_PROXY ||
           process.env.http_proxy || null;
	}

	return process.env.HTTP_PROXY ||
         process.env.http_proxy || null;
}

module.exports = function (url) {
	const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';

	// If the hostname is 'unix' then it's a unix socket
	if (url.hostname === 'unix') {
		return null;
	}
	// If no_proxy is a wildcard return null immediately
	if (noProxy === '*') {
		return null;
	}
	const proxy = getProxyFromProtocol(url);
	if (proxy && validate(noProxy, url)) {
		return new ProxyAgent(proxy);
	}

	return null;
};
