const url = require('url');
const is = require('@sindresorhus/is');

module.exports = (defaults, options = {}) => {
	return merge({}, defaults, options);
};

function merge(target = {}, ...sources) {
	for (const source of sources) {
		for (const [key, sourceValue] of Object.entries(source)) {
			const targetValue = target[key];
			if (is.undefined(sourceValue)) {
				delete target[key];
			} else if (is.urlInstance(targetValue) && (
				is.urlInstance(sourceValue) || is.string(sourceValue)
			)) {
				target[key] = new url.URL(sourceValue, targetValue);
			} else if (is.plainObject(sourceValue)) {
				if (is.plainObject(targetValue)) {
					target[key] = merge({}, targetValue, sourceValue);
				} else {
					target[key] = merge({}, sourceValue);
				}
			} else {
				target[key] = sourceValue;
			}
		}
	}
	return target;
}
