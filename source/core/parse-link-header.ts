const splitHeaderValue = (value: string, separator: string): string[] => {
	const values = [];
	let current = '';
	let inQuotes = false;
	let inReference = false;
	let isEscaped = false;

	for (const character of value) {
		if (inQuotes && isEscaped) {
			current += character;
			isEscaped = false;
			continue;
		}

		if (inQuotes && character === '\\') {
			current += character;
			isEscaped = true;
			continue;
		}

		if (character === '"') {
			inQuotes = !inQuotes;
			current += character;
			continue;
		}

		if (!inQuotes && character === '<') {
			inReference = true;
			current += character;
			continue;
		}

		if (!inQuotes && character === '>') {
			inReference = false;
			current += character;
			continue;
		}

		// Link headers use both quoted strings and <URI-reference> values, so raw
		// splitting on `,` / `;` would break valid values containing those characters.
		if (!inQuotes && !inReference && character === separator) {
			values.push(current);
			current = '';
			continue;
		}

		current += character;
	}

	if (inQuotes || isEscaped) {
		throw new Error(`Failed to parse Link header: ${value}`);
	}

	values.push(current);
	return values;
};

export default function parseLinkHeader(link: string) {
	const parsed = [];

	const items = splitHeaderValue(link, ',');

	for (const item of items) {
		// https://tools.ietf.org/html/rfc5988#section-5
		const [rawUriReference, ...rawLinkParameters] = splitHeaderValue(item, ';') as [string, ...string[]];
		const trimmedUriReference = rawUriReference.trim();

		// eslint-disable-next-line @typescript-eslint/prefer-string-starts-ends-with
		if (trimmedUriReference[0] !== '<' || trimmedUriReference.at(-1) !== '>') {
			throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
		}

		const reference = trimmedUriReference.slice(1, -1);
		const parameters: Record<string, string> = {};

		if (reference.includes('<') || reference.includes('>')) {
			throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
		}

		if (rawLinkParameters.length === 0) {
			throw new Error(`Unexpected end of Link header parameters: ${rawLinkParameters.join(';')}`);
		}

		for (const rawParameter of rawLinkParameters) {
			const trimmedRawParameter = rawParameter.trim();
			const center = trimmedRawParameter.indexOf('=');

			if (center === -1) {
				throw new Error(`Failed to parse Link header: ${link}`);
			}

			const name = trimmedRawParameter.slice(0, center).trim();
			const value = trimmedRawParameter.slice(center + 1).trim();

			parameters[name] = value;
		}

		parsed.push({
			reference,
			parameters,
		});
	}

	return parsed;
}
