import {URL} from 'url';

export default function isUnixSocketURL(url: URL) {
	return url.protocol === 'unix:' || url.hostname === 'unix';
}
