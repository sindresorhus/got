/**
Extract the lowercased field names nominated by a Connection or Proxy-Connection header.
*/
export default function getConnectionHeaderTokens(value: string | string[] | number | undefined): string[] {
	if (value === undefined) {
		return [];
	}

	const values = Array.isArray(value) ? value : [value];
	const tokens: string[] = [];

	for (const item of values) {
		for (const token of String(item).split(',')) {
			const normalizedToken = token.trim().toLowerCase();

			if (normalizedToken.length > 0) {
				tokens.push(normalizedToken);
			}
		}
	}

	return tokens;
}
