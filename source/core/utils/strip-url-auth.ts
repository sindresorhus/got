/*
Returns the URL as a string with `username` and `password` stripped.
*/
export default function stripUrlAuth(url: URL | string): string {
	const sanitized = new URL(url);
	sanitized.username = '';
	sanitized.password = '';
	return sanitized.toString();
}
