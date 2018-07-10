'use strict';

const WHITELIST = [
	'ETIMEDOUT',
	'ECONNRESET',
	'EADDRINUSE',
	'ESOCKETTIMEDOUT',
	'ECONNREFUSED',
	'EPIPE'
];

module.exports = err => {
	if (err && WHITELIST.includes(err.code)) {
		return true;
	}

	return false;
};
