'use strict';
const is = require('@sindresorhus/is');

module.exports = function deepFreeze(object) {
	for (const [key, value] of Object.entries(object)) {
		if (is.object(value)) {
			deepFreeze(object[key]);
		}
	}

	return Object.freeze(object);
};
