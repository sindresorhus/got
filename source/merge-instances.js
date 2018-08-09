'use strict';
const merge = require('./merge');
const knownHookEvents = require('./known-hook-events');

module.exports = (instances, methods) => {
	const handlers = instances.map(instance => instance.defaults.handler);
	const size = instances.length - 1;

	let options = {};
	const hooks = {};
	for (const instance of instances) {
		options = merge({}, options, instance.defaults.options);

		const instanceHooks = instance.defaults.options.hooks;
		if (instanceHooks) {
			for (const name of knownHookEvents) {
				if (!instanceHooks[name]) {
					continue;
				}

				if (hooks[name]) {
					hooks[name] = hooks[name].concat(instanceHooks[name]);
				} else {
					hooks[name] = [...instanceHooks[name]];
				}
			}
		}
	}

	options.hooks = hooks;

	return {
		methods,
		options,
		handler: (options, next) => {
			let iteration = -1;
			const iterate = options => handlers[++iteration](options, iteration === size ? next : iterate);

			return iterate(options);
		}
	};
};
