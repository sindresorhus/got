import is from '@sindresorhus/is';

export default function deepFreeze<T extends Record<string, any>>(object: T): Readonly<T> {
	for (const value of Object.values(object)) {
		if (is.plainObject(value) || is.array(value)) {
			deepFreeze(value);
		}
	}

	return Object.freeze(object);
}
