'use strict';
const is = require('@sindresorhus/is');

const deepFreeze = obj => {
	for (const [key, value] of Object.entries(obj)) {
		if (is.object(value)) {
			deepFreeze(obj[key]);
		}
	}

	return Object.freeze(obj);
};

module.exports = (where, properties) => {
	for (const [key, value] of Object.entries(properties)) {
		Object.defineProperty(where, key, {
			value: deepFreeze(value),
			writable: false,
			enumerable: true,
			configurable: true
		});
	}
};
