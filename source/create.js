'use strict';
const is = require('@sindresorhus/is');
const errors = require('./errors');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');
const merge = require('./merge');
const deepFreeze = require('./deep-freeze');

const next = options => options.stream ? asStream(options) : asPromise(options);
const mergeOptions = (defaults, options = {}) => merge({}, defaults, options);

const create = defaults => {
	defaults = merge({}, defaults);
	if (!defaults.handler) {
		defaults.handler = next;
	}

	function got(url, options) {
		try {
			options = mergeOptions(defaults.options, options);
			return defaults.handler(normalizeArguments(url, options, defaults), next);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = create;
	got.extend = (options = {}) => create({
		options: mergeOptions(defaults.options, options),
		methods: defaults.methods,
		handler: defaults.handler
	});

	const merge = (instances, methods = instances[0].defaults.methods) => {
		for (const instance of instances) {
			if (Reflect.has(instance.defaults, 'mergeable') && !instance.defaults.mergeable) {
				throw new Error('Couldn\'t perform merge on unmergeable instances.');
			}
		}

		const handlers = instances.map(instance => instance.defaults.handler);
		const size = instances.length - 1;

		let options = {};
		for (const instance of instances) {
			options = assignOptions(options, instance.defaults.options);
		}

		return create({
			methods,
			options,
			handler: (url, options, next) => {
				let iteration = -1;

				const iterate = options => {
					iteration++;
					return handlers[iteration](url, options, iteration === size ? next : iterate);
				};

				return iterate(options);
			}
		});
	};

	got.merge = (instances, methods) => {
		// Single instance
		if (is.function(instances)) {
			return merge([got, instances], methods);
		}

		// Many instances
		return merge(instances, methods);
	};

	got.stream = (url, options) => {
		options = mergeOptions(defaults.options, options);
		options.stream = true;
		return defaults.handler(normalizeArguments(url, options, defaults), next);
	};

	for (const method of defaults.methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, {...errors, mergeOptions});
	Object.defineProperty(got, 'defaults', {
		value: deepFreeze(defaults),
		writable: false,
		enumerable: true,
		configurable: true
	});

	return got;
};

module.exports = create;
