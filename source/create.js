'use strict';
const is = require('@sindresorhus/is');
const errors = require('./errors');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');
const merge = require('./merge');
const deepFreeze = require('./deep-freeze');
const mergeInstances = require('./merge-instances');

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

	got.mergeInstances = (...args) => {
		const lastArgument = args[args.length - 1];
		let methods;
		let instances;

		if (is.array(lastArgument)) {
			methods = lastArgument;
			instances = args.slice(0, -1);
		} else {
			methods = args[0].defaults.methods; // eslint-disable-line prefer-destructuring
			instances = args;
		}

		return create(mergeInstances(instances, methods));
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
