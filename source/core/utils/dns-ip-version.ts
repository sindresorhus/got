export type DnsIpVersion = 'auto' | 'ipv4' | 'ipv6';
export type DnsIpFamily = 0 | 4 | 6;

const conversionTable = {
	auto: 0,
	ipv4: 4,
	ipv6: 6
};

export const isDnsIpVersion = (value: unknown): boolean => {
	if (typeof value === 'string') {
		return value in conversionTable;
	}

	return false;
};

export const dnsIpVersionToFamily = (dnsIpVersion: DnsIpVersion): DnsIpFamily => {
	if (isDnsIpVersion(dnsIpVersion)) {
		return conversionTable[dnsIpVersion] as DnsIpFamily;
	}

	throw new Error('Invalid DnsIpVersion');
};
