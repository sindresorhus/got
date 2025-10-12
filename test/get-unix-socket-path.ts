import test from 'ava';
import {getUnixSocketPath} from '../source/core/utils/is-unix-socket-url.js';

test('returns socket path for unix: protocol URLs', t => {
	const url = new URL('unix:/foo/bar.sock:/path');
	t.is(getUnixSocketPath(url), '/foo/bar.sock');
});

test('returns socket path for http://unix URLs', t => {
	const url = new URL('http://unix/foo/bar.sock:/path');
	t.is(getUnixSocketPath(url), '/foo/bar.sock');
});

test('returns different socket paths for different sockets', t => {
	const url1 = new URL('http://unix/tmp/socket1:/path');
	const url2 = new URL('http://unix/tmp/socket2:/path');

	t.is(getUnixSocketPath(url1), '/tmp/socket1');
	t.is(getUnixSocketPath(url2), '/tmp/socket2');
	t.not(getUnixSocketPath(url1), getUnixSocketPath(url2));
});

test('returns undefined for regular HTTP URLs', t => {
	const url = new URL('http://example.com/path');
	t.is(getUnixSocketPath(url), undefined);
});

test('returns undefined for HTTPS URLs', t => {
	const url = new URL('https://example.com/path');
	t.is(getUnixSocketPath(url), undefined);
});

test('handles socket paths with special characters', t => {
	const url = new URL('http://unix/tmp/my-app.sock:/api/endpoint');
	t.is(getUnixSocketPath(url), '/tmp/my-app.sock');
});
