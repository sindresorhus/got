'use strict';
const merge = require('./merge');

module.exports = (instances, methods) => {
	for (const [index, instance] of instances.entries()) {
		if (Reflect.has(instance.defaults, 'mergeable') && !instance.defaults.mergeable) {
			throw new Error(`Instance ${index} is not mergeable.`);
		}
	}

	const handlers = instances.map(instance => instance.defaults.handler);
	const size = instances.length - 1;

	let options = {};
	for (const instance of instances) {
		options = merge({}, options, instance.defaults.options);
	}

	return {
		methods,
		options,
		handler: (options, next) => {
			let iteration = -1;

			const iterate = options => {
				iteration++;
				return handlers[iteration](options, iteration === size ? next : iterate);
			};

			return iterate(options);
		}
	};
};
