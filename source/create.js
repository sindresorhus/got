'use strict';
const errors = require('./errors');
const assignOptions = require('./assign-options');
const normalizeArguments = require('./normalize-arguments');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');

const create = defaults => {
	function got(url, options) {
		try {
			options = assignOptions(defaults.options, options);
			return defaults.handler(url, options);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = newDefaults => create(newDefaults);
	got.extend = (options = {}) => create({
		options: assignOptions(defaults.options, options),
		methods: defaults.methods,
		handler: defaults.handler
	});

	got.stream = (url, options) => {
		options = assignOptions(defaults.options, options);
		options.stream = true;
		return defaults.handler(url, options);
	};

	for (const method of defaults.methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);
	Object.assign(got, {asStream, asPromise, defaults});

	return got;
};

module.exports = create;
