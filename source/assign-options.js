const extend = require('extend');
const is = require('@sindresorhus/is');

module.exports = (defaults, options = {}) => {
	const returnOptions = extend(true, {}, defaults, options);

	if (Reflect.has(options, 'headers')) {
		for (const [key, value] of Object.entries(options.headers)) {
			if (is.nullOrUndefined(value)) {
				delete returnOptions.headers[key];
			}
		}
	}

	// Override these arrays because we don't want to extend them
	if (is.object(options.retry)) {
		if (Reflect.has(options.retry, 'methods')) {
			returnOptions.retry.methods = options.retry.methods;
		}

		if (Reflect.has(options.retry, 'statusCodes')) {
			returnOptions.retry.statusCodes = options.retry.statusCodes;
		}
	}

	return returnOptions;
};
