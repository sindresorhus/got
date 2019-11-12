import is from '@sindresorhus/is';

export default function merge<Target extends Record<string, any>, Source extends Record<string, any>>(target: Target, ...sources: Source[]): Target & Source {
	for (const source of sources) {
		for (const [key, sourceValue] of Object.entries(source)) {
			const targetValue = target[key];
			if (targetValue instanceof URLSearchParams && sourceValue instanceof URLSearchParams) {
				const params = new URLSearchParams();

				const append = (value: string, key: string): void => params.append(key, value);
				targetValue.forEach(append);
				sourceValue.forEach(append);

				// @ts-ignore https://github.com/microsoft/TypeScript/issues/31661
				target[key] = params;
			} else if (is.urlInstance(targetValue) && is.string(sourceValue)) {
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
