'use strict';
const pkg = require('../package.json');
const create = require('./create');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');

const defaults = {
	handler: (url, options) => {
		if (options.stream) {
			return asStream(url, options);
		}

		return asPromise(url, options);
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
