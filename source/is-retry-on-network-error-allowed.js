'use strict';

const WHITELIST = new Set([
	'ETIMEDOUT',
	'ECONNRESET',
	'EADDRINUSE',
	'ECONNREFUSED',
	'EPIPE'
]);

module.exports = error => {
	if (error && WHITELIST.has(error.code)) {
		return true;
	}

	return false;
};
