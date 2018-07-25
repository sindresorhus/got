'use strict';
const errors = require('./errors');
const assignOptions = require('./assign-options');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');
const deepFreeze = require('./deep-freeze');

const next = options => {
	if (options.stream) {
		return asStream(options);
	}

	return asPromise(options);
};

const create = defaults => {
	if (!defaults.handler) {
		defaults.handler = (options, next) => next(options);
	}

	function got(url, options) {
		try {
			options = assignOptions(defaults.options, options);
			return defaults.handler(normalizeArguments(url, options, defaults), next);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = create;
	got.extend = (options = {}) => create({
		options: assignOptions(defaults.options, options),
		methods: defaults.methods,
		handler: defaults.handler
	});

	got.stream = (url, options) => {
		options = assignOptions(defaults.options, options);
		options.stream = true;
		return defaults.handler(normalizeArguments(url, options, defaults), next);
	};

	for (const method of defaults.methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, {...errors, assignOptions});
	Object.defineProperty(got, 'defaults', {
		value: deepFreeze(defaults),
		writable: false,
		enumerable: true,
		configurable: true
	});

	return got;
};

module.exports = create;
