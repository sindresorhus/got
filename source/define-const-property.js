'use strict';
const is = require('@sindresorhus/is');

const deepFreeze = (obj, excluded = []) => {
	for (const [key, value] of Object.entries(obj)) {
		if (is.object(value) && !excluded.includes(key)) {
			deepFreeze(obj[key], excluded);
		}
	}

	return Object.freeze(obj);
};

module.exports = (where, properties, deep, excluded) => {
	for (const [key, value] of Object.entries(properties)) {
		Object.defineProperty(where, key, {
			value: deep ? deepFreeze(value, excluded) : Object.freeze(value),
			writable: false,
			enumerable: true,
			configurable: true
		});
	}
};
module.exports.deepFreeze = deepFreeze;
