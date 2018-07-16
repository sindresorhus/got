'use strict';
const is = require('@sindresorhus/is');

module.exports = (where, properties, deep, excluded) => {
	const deepFreeze = (obj, parent) => {
		for (const [key, value] of Object.entries(obj)) {
			const name = parent + '.' + key;

			if (is.object(value) && !excluded.includes(name)) {
				deepFreeze(obj[key], name);
			}
		}

		return excluded.includes(parent) ? obj : Object.freeze(obj);
	};

	for (const [key, value] of Object.entries(properties)) {
		Object.defineProperty(where, key, {
			value: deep ? deepFreeze(value, key) : Object.freeze(value),
			writable: false,
			enumerable: true,
			configurable: true
		});
	}
};
