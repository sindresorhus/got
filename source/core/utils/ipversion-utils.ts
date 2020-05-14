export type IpVersion = 'auto' | 'ipv4' | 'ipv6';
export type IpFamily = 0 | 4 | 6;

const conversionTable = {
	auto: 0,
	ipv4: 4,
	ipv6: 6
};

export const isIpVersion = (value: unknown): boolean => {
	if (typeof value === 'string') {
		return value in conversionTable;
	}

	return false;
};

export const ipVersionToFamily = (ipVersion: IpVersion): IpFamily => {
	if (isIpVersion(ipVersion)) {
		return conversionTable[ipVersion] as IpFamily;
	}

	throw new Error('Invalid IpVersion');
};
