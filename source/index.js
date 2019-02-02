'use strict';
const pkg = require('../package.json');
const create = require('./create');

// @todo
// I exported this default to be able to infer typings from it.
// I'm guessing this `defaults` is being merged with user options
// so `as-stream` receives an object that has merged props.
// Let's get a confirmation from a maintainer but I can also create an explicit typings for it.
export const defaults = {
	options: {
		retry: {
			retries: 2,
			methods: [
				'GET',
				'PUT',
				'HEAD',
				'DELETE',
				'OPTIONS',
				'TRACE'
			],
			statusCodes: [
				408,
				413,
				429,
				500,
				502,
				503,
				504
			],
			errorCodes: [
				'ETIMEDOUT',
				'ECONNRESET',
				'EADDRINUSE',
				'ECONNREFUSED',
				'EPIPE',
				'ENOTFOUND',
				'ENETUNREACH',
				'EAI_AGAIN'
			]
		},
		headers: {
			'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
		},
		hooks: {
			beforeRequest: [],
			beforeRedirect: [],
			beforeRetry: [],
			afterResponse: []
		},
		decompress: true,
		throwHttpErrors: true,
		followRedirect: true,
		stream: false,
		cache: false,
		useElectronNet: false,
		responseType: 'text',
		resolveBodyOnly: false
	},
	mutableDefaults: false
};

const got = create(defaults);

module.exports = got;
