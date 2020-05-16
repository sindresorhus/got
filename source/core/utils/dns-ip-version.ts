export type DnsIpVersion = 'auto' | 'ipv4' | 'ipv6';
type DnsIpFamily = 0 | 4 | 6;

const conversionTable = {
	auto: 0,
	ipv4: 4,
	ipv6: 6
};

export const isDnsIpVersion = (value: any): boolean => {
	return value in conversionTable;
};

export const dnsIpVersionToFamily = (dnsIpVersion: DnsIpVersion): DnsIpFamily => {
	if (isDnsIpVersion(dnsIpVersion)) {
		return conversionTable[dnsIpVersion] as DnsIpFamily;
	}

	throw new Error('Invalid DnsIpVersion');
};
