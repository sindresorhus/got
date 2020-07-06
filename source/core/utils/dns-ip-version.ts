export type DnsLookupIpVersion = 'auto' | 'ipv4' | 'ipv6';
type DnsIpFamily = 0 | 4 | 6;

const conversionTable = {
	auto: 0,
	ipv4: 4,
	ipv6: 6
};

export const isDnsLookupIpVersion = (value: any): boolean => {
	return value in conversionTable;
};

export const dnsLookupIpVersionToFamily = (dnsLookupIpVersion: DnsLookupIpVersion): DnsIpFamily => {
	if (isDnsLookupIpVersion(dnsLookupIpVersion)) {
		return conversionTable[dnsLookupIpVersion] as DnsIpFamily;
	}

	throw new Error('Invalid DNS lookup IP version');
};
