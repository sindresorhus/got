import is from '@sindresorhus/is';

export default function merge<Target extends Record<string, any>, Source extends Record<string, any>>(target: Target, ...sources: Source[]): Target & Source {
	for (const source of sources) {
		for (const [key, sourceValue] of Object.entries(source)) {
			const targetValue = target[key];

			if (is.urlInstance(targetValue) && is.string(sourceValue)) {
				// @ts-ignore
				target[key] = new URL(sourceValue, targetValue);
			} else if (is.plainObject(sourceValue)) {
				if (is.plainObject(targetValue)) {
					// @ts-ignore
					target[key] = merge({}, targetValue, sourceValue);
				} else {
					// @ts-ignore
					target[key] = merge({}, sourceValue);
				}
			} else if (is.array(sourceValue)) {
				// @ts-ignore
				target[key] = sourceValue.slice();
			} else {
				// @ts-ignore
				target[key] = sourceValue;
			}
		}
	}

	return target as Target & Source;
}
