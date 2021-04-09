export default function parseLinkHeader(link: string) {
	const parsed = [];

	const items = link.split(',');

	for (const item of items) {
		// https://tools.ietf.org/html/rfc5988#section-5
		const [rawUriReference, ...rawLinkParameters] = item.split(';');

		const reference = rawUriReference!.trim().slice(1, -1);
		const parameters: Record<string, string> = {};

		if (rawLinkParameters.length === 0) {
			throw new Error('Unexpected end of Link header parameters');
		}

		for (const rawParameter of rawLinkParameters) {
			const center = rawParameter.indexOf('=');
			const name = rawParameter.slice(0, center).trim();
			const value = rawParameter.slice(center + 1).trim();

			parameters[name] = value;
		}

		parsed.push({
			reference,
			parameters
		});
	}

	return parsed;
}
