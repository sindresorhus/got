import packageJson = require('../package.json');
import create from './create';
import {Defaults} from './utils/types.js';

const defaults: Partial<Defaults> = {
	options: {
		method: 'GET',
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
			'user-agent': `${packageJson.name}/${packageJson.version} (https://github.com/sindresorhus/got)`
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
		dnsCache: false,
		useElectronNet: false,
		responseType: 'text',
		resolveBodyOnly: false
	},
	mutableDefaults: false
};

const got = create(defaults);

export default got;

// For CommonJS default export support
module.exports = got;
module.exports.default = got;
