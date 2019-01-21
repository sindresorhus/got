import is from '@sindresorhus/is';

interface SearchParams {
	[key: string]: string | number | boolean | null;
}

const verify = (value: unknown, type: string) => {
	if (!is.string(value) && !is.number(value) && !is.boolean(value) && !is.null_(value)) {
		throw new TypeError(`The \`searchParams\` ${type} '${value}' must be a string, number, boolean or null`);
	}
};

export default (searchParam: SearchParams) => {
	for (const [key, value] of Object.entries(searchParam)) {
		verify(key, 'key');
		verify(value, 'value');
	}
};
