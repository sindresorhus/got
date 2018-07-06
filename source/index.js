'use strict';
const pkg = require('../package.json');
const create = require('./create');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');

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

const methods = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

const handler = (url, options, isStream) => {
	const normalizedArgs = normalizeArguments(url, options);

	if (isStream || normalizedArgs.stream) {
		return asStream(normalizedArgs);
	}

	return asPromise(normalizedArgs);
};

const got = create(options, methods, handler);

module.exports = got;
module.exports.defaults = {options, methods, handler};
