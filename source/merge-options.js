const {URL} = require('url');
const is = require('@sindresorhus/is');

module.exports = (defaults, options = {}) => {
	return merge({}, defaults, options);
};

function merge(target, ...sources) {
	for (const source of sources) {
		const sourceIter = is.array(source) ?
			source.entries() :
			Object.entries(source);
		for (const [key, sourceValue] of sourceIter) {
			const targetValue = target[key];
			if (is.undefined(sourceValue)) {
				continue;
			}
			if (is.array(sourceValue)) {
				target[key] = merge(new Array(sourceValue.length), sourceValue);
			} else if (is.urlInstance(targetValue) && (
				is.urlInstance(sourceValue) || is.string(sourceValue)
			)) {
				target[key] = new URL(sourceValue, targetValue);
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
