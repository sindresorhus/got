import is from '@sindresorhus/is';

const verify = (value: unknown, type: string): void => {
	if (!is.string(value) && !is.number(value) && !is.boolean(value) && !is.null_(value)) {
		throw new TypeError(`The \`searchParams\` ${type} '${value}' must be a string, number, boolean or null`);
	}
};

export default (searchParams: Record<string, unknown>): void => {
	for (const [key, value] of Object.entries(searchParams)) {
		verify(key, 'key');
		verify(value, 'value');
	}
};
