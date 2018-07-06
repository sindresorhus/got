'use strict';
const extend = require('extend');
const is = require('@sindresorhus/is');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const errors = require('./errors');
const normalizeArguments = require('./normalize-arguments');

const assignOptions = (defaults, options = {}) => {
	const opts = extend(true, {}, defaults, options);

	if (Reflect.has(options, 'headers')) {
		for (const [key, value] of Object.entries(options.headers)) {
			if (is.nullOrUndefined(value)) {
				delete opts.headers[key];
				continue;
			}
		}
	}

	return opts;
};

const create = (defaults = {}) => {
	function got(url, options) {
		try {
			options = assignOptions(defaults, options);
			const normalizedArgs = normalizeArguments(url, options);

			if (normalizedArgs.stream) {
				return asStream(normalizedArgs);
			}

			return asPromise(normalizedArgs);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = (options = {}) => create(assignOptions(defaults, options));

	got.stream = (url, options) => {
		options = assignOptions(defaults, options);
		return asStream(normalizeArguments(url, options));
	};

	const methods = [
		'get',
		'post',
		'put',
		'patch',
		'head',
		'delete'
	];

	for (const method of methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);

	return got;
};

module.exports = create;
