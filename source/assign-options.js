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

	return opts;
};
