'use strict';
const errors = require('./errors');
const assignOptions = require('./assign-options');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');

const next = (url, options) => {
	options = normalizeArguments(url, options);

	if (options.stream) {
		return asStream(options);
	}

	return asPromise(options);
};

const create = defaults => {
	function got(url, options) {
		try {
			options = assignOptions(defaults.options, options);
			return defaults.handler(url, options, next);
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
		return defaults.handler(url, options, next);
	};

	for (const method of defaults.methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);
	Object.assign(got, {defaults});

	return got;
};

module.exports = create;
