'use strict';

const WHITELIST = new Set([
	'ETIMEDOUT',
	'ECONNRESET',
	'EADDRINUSE',
	'ESOCKETTIMEDOUT',
	'ECONNREFUSED',
	'EPIPE'
]);

module.exports = err => {
	if (err && WHITELIST.has(err.code)) {
		return true;
	}

	return false;
};
