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
	got.fork = (newDefaults = {}) => {
		if (Reflect.has(newDefaults, 'options')) {
			return create({
				options: assignOptions(defaults.options, newDefaults.options),
				methods: newDefaults.methods || defaults.methods,
				handler: newDefaults.handler || defaults.handler
			});
		}

		return create({
			options: assignOptions(defaults.options, newDefaults),
			methods: defaults.methods,
			handler: defaults.handler
		});
	};

	got.stream = (url, options) => {
		options = assignOptions(defaults.options, options);
		return defaults.handler(url, options, true);
	};

	for (const method of defaults.methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);
	Object.assign(got, {normalizeArguments, asStream, asPromise, defaults});

	return got;
};

module.exports = create;
