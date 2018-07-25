const url = require('url');
const mergeWith = require('lodash.mergewith');
const cloneDeep = require('lodash.clonedeep');
const is = require('@sindresorhus/is');

module.exports = (defaults, options = {}) => {
	return mergeWith(
		{opts: cloneDeep(defaults)},
		{opts: options},
		customizer
	).opts;
};

function customizer(objValue, srcValue) {
	if (is.array(srcValue) || is.array(objValue)) {
		return cloneDeep(srcValue);
	}
	if (objValue instanceof url.URL) {
		return new url.URL(srcValue, objValue);
	}
	if (![objValue, srcValue].some(is.array) && [objValue, srcValue].every(is.object)) {
		// When both args are non-array objects, delete keys for which the source
		// value is undefined (null is a significant value places, e.g. `encoding`).
		const deleteKeys = [];
		for (const key in srcValue) {
			if (is.undefined(srcValue[key])) {
				deleteKeys.push(key);
			}
		}
		const result = mergeWith(objValue, srcValue, customizer);
		for (const key of deleteKeys) {
			delete result[key];
		}
		return result;
	}
}
