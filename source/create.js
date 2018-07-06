'use strict';
const errors = require('./errors');
const assignOptions = require('./assign-options');
const normalizeArguments = require('./normalize-arguments');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');

const create = (defaults = {}, methods = [], handle) => {
	function got(url, options) {
		try {
			options = assignOptions(defaults, options);
			return handle(url, options);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = (options = {}) => create(assignOptions(defaults, options), methods, handle);

	got.stream = (url, options) => {
		options = assignOptions(defaults, options);
		return handle(url, options, true);
	};

	for (const method of methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);

	return got;
};

module.exports = create;
module.exports.normalizeArguments = normalizeArguments;
module.exports.asStream = asStream;
module.exports.asPromise = asPromise;
