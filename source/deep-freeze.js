'use strict';
const is = require('@sindresorhus/is');

module.exports = function deepFreeze(obj) {
	for (const [key, value] of Object.entries(obj)) {
		if (is.object(value)) {
			deepFreeze(obj[key]);
		}
	}

	return Object.freeze(obj);
};
