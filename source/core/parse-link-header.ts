const splitHeaderValue = (value: string, separator: string): string[] => {
	const values = [];
	let current = '';
	let inQuotes = false;
	let inReference = false;
	let isEscaped = false;

	for (const character of value) {
		if (inQuotes) {
			if (isEscaped) {
				isEscaped = false;
			} else if (character === '\\') {
				isEscaped = true;
			} else if (character === '"') {
				inQuotes = false;
			}
		} else if (character === '"') {
			inQuotes = true;
		} else if (character === '<' || character === '>') {
			inReference = character === '<';
		} else if (!inReference && character === separator) {
			// Link headers use both quoted strings and <URI-reference> values, so raw
			// splitting on `,` / `;` would break valid values containing those characters.
			values.push(current);
			current = '';
			continue;
		}

		current += character;
	}

	if (inQuotes) {
		throw new Error(`Failed to parse Link header: ${value}`);
	}

	values.push(current);
	return values;
};

export default function parseLinkHeader(link: string) {
	const parsed = [];

	for (const item of splitHeaderValue(link, ',')) {
		// HTTP list recipients ignore empty members (RFC 9110, section 5.6.1.2).
		if (item.trim() === '') {
			continue;
		}

		// https://tools.ietf.org/html/rfc5988#section-5
		const [rawUriReference, ...rawLinkParameters] = splitHeaderValue(item, ';') as [string, ...string[]];
		const trimmedUriReference = rawUriReference.trim();

		// eslint-disable-next-line @typescript-eslint/prefer-string-starts-ends-with
		if (trimmedUriReference[0] !== '<' || trimmedUriReference.at(-1) !== '>') {
			throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
		}

		// Optional whitespace is allowed inside the angle brackets (RFC 8288, section 3).
		const reference = trimmedUriReference.slice(1, -1).trim();
		if (reference.includes('<') || reference.includes('>')) {
			throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
		}

		// Parameter names can match `Object.prototype` properties, so use a null-prototype object.
		const parameters: Record<string, string> = Object.create(null) as Record<string, string>;

		for (const rawParameter of rawLinkParameters) {
			const trimmedRawParameter = rawParameter.trim();
			const center = trimmedRawParameter.indexOf('=');
			// The parameter value is optional. See https://www.rfc-editor.org/rfc/rfc8288#section-3
			const name = center === -1 ? trimmedRawParameter : trimmedRawParameter.slice(0, center).trim();

			if (name === '') {
				throw new Error(`Failed to parse Link header: ${link}`);
			}

			const value = center === -1 ? '' : trimmedRawParameter.slice(center + 1).trim();

			const normalizedName = name.toLowerCase();

			if (!Object.hasOwn(parameters, normalizedName)) {
				parameters[normalizedName] = value;
			}
		}

		parsed.push({
			reference,
			parameters,
		});
	}

	return parsed;
}
