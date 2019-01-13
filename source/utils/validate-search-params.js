'use strict';
const is = require('@sindresorhus/is');

module.exports = query => {
	const verify = (value, type) => {
		if (!is.string(value) && !is.number(value) && !is.boolean(value) && !is.null(value)) {
			throw new TypeError(`The query ${type} '${value}' must be a string, number, boolean or null`);
		}
	};

	for (const [key, value] of Object.entries(query)) {
		verify(key, 'key');
		verify(value, 'value');
	}
};
