'use strict';
const pkg = require('../package.json');
const create = require('./create');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');

const defaults = {
	handler: (url, options, isStream) => {
		const normalizedArgs = normalizeArguments(url, options);

		if (isStream || normalizedArgs.stream) {
			return asStream(normalizedArgs);
		}

		return asPromise(normalizedArgs);
	},
	methods: [
		'get',
		'post',
		'put',
		'patch',
		'head',
		'delete'
	],
	options: {
		retries: 2,
		cache: false,
		decompress: true,
		useElectronNet: false,
		throwHttpErrors: true,
		headers: {
			'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
		}
	}
};

const got = create(defaults);

module.exports = got;
