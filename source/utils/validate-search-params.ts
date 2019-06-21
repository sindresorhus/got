import is from '@sindresorhus/is';

export default (searchParams: Record<string, unknown>): void => {
	for (const value of Object.values(searchParams)) {
		if (!is.string(value) && !is.number(value) && !is.boolean(value) && !is.null_(value)) {
			throw new TypeError(`The \`searchParams\` value '${value}' must be a string, number, boolean or null`);
		}
	}
};
