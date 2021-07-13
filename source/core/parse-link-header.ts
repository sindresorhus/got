export default function parseLinkHeader(link: string) {
	const parsed = [];

	const items = link.split(',');

	for (const item of items) {
		// https://tools.ietf.org/html/rfc5988#section-5
		const [rawUriReference, ...rawLinkParameters] = item.split(';') as [string, ...string[]];
		const trimmedUriReference = rawUriReference.trim();

		// eslint-disable-next-line @typescript-eslint/prefer-string-starts-ends-with
		if (trimmedUriReference[0] !== '<' || trimmedUriReference[trimmedUriReference.length - 1] !== '>') {
			throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
		}

		const reference = trimmedUriReference.slice(1, -1);
		const parameters: Record<string, string> = {};

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
