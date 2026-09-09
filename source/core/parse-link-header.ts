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

	if (inQuotes) {
		throw new Error(`Failed to parse Link header: ${value}`);
	}

	values.push(current);
	return values;
};

export default function parseLinkHeader(link: string) {
	const parsed = [];

	const items = splitHeaderValue(link, ',');

	for (const item of items) {
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

		const reference = trimmedUriReference.slice(1, -1);
		const parameters: Record<string, string> = {};

		if (reference.includes('<') || reference.includes('>')) {
			throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
		}

		for (const rawParameter of rawLinkParameters) {
			const trimmedRawParameter = rawParameter.trim();
			const center = trimmedRawParameter.indexOf('=');
			// The parameter value is optional. See https://www.rfc-editor.org/rfc/rfc8288#section-3
			const name = center === -1 ? trimmedRawParameter : trimmedRawParameter.slice(0, center).trim();
			const value = center === -1 ? '' : trimmedRawParameter.slice(center + 1).trim();

			if (name === '') {
				throw new Error(`Failed to parse Link header: ${link}`);
			}

			const normalizedName = name.toLowerCase();

			if (!Object.hasOwn(parameters, normalizedName)) {
				Object.defineProperty(parameters, normalizedName, {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}

		parsed.push({
			reference,
			parameters,
		});
	}

	return parsed;
}
