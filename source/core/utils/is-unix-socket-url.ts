// eslint-disable-next-line @typescript-eslint/naming-convention
export default function isUnixSocketURL(url: URL) {
	return url.protocol === 'unix:' || url.hostname === 'unix';
}
