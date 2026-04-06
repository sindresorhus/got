
export default function isUnixSocketUrl(url: URL) {
	return url.protocol === 'unix:' || url.hostname === 'unix';
}

/**
Extract the socket path from a UNIX socket URL.

@example
```
getUnixSocketPath(new URL('http://unix/foo:/path'));
//=> '/foo'

getUnixSocketPath(new URL('unix:/foo:/path'));
//=> '/foo'

getUnixSocketPath(new URL('http://example.com'));
//=> undefined
```
*/
export function getUnixSocketPath(url: URL): string | undefined {
	if (!isUnixSocketUrl(url)) {
		return undefined;
	}

	return /^(?<socketPath>[^:]+):/v.exec(`${url.pathname}${url.search}`)?.groups?.socketPath;
}
