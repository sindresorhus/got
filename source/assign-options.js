const extend = require('extend');
const is = require('@sindresorhus/is');

module.exports = (defaults, options = {}) => {
	const opts = extend(true, {}, defaults, options);

	if (Reflect.has(options, 'headers')) {
		for (const [key, value] of Object.entries(options.headers)) {
			if (is.nullOrUndefined(value)) {
				delete opts.headers[key];
			}
		}
	}

	// Override these arrays because we don't want to extend them
	if (is.object(options.retry)) {
		if (Reflect.has(options.retry, 'methods')) {
			opts.retry.methods = options.retry.methods;
		}

		if (Reflect.has(options.retry, 'statusCodes')) {
			opts.retry.statusCodes = options.retry.statusCodes;
		}
	}

	return opts;
};
