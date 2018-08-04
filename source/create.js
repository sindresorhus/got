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

const mergeInstances = (instances, methods = instances[0].defaults.methods) => {
	for (const [n, instance] of instances.entries()) {
		if (Reflect.has(instance.defaults, 'mergeable') && !instance.defaults.mergeable) {
			throw new Error('Instance ' + n + ' is not mergeable.');
		}
	}

	const handlers = instances.map(instance => instance.defaults.handler);
	const size = instances.length - 1;

	let options = {};
	for (const instance of instances) {
		options = mergeOptions(options, instance.defaults.options);
	}

	// eslint-disable-next-line no-use-before-define
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

	got.merge = (instances, methods) => {
		// Single instance
		if (is.function(instances)) {
			return mergeInstances([got, instances], methods);
		}

		// Many instances
		return mergeInstances(instances, methods);
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
