'use strict';
const pkg = require('../package.json');
const create = require('./create');

const options = {
	retries: 2,
	cache: false,
	decompress: true,
	useElectronNet: false,
	throwHttpErrors: true,
	headers: {
		'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`
	}
};

const got = create(options);

module.exports = got;
module.exports.defaults = options;
