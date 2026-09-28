import assert from 'node:assert/strict';
import {getUnixSocketPath} from '../source/core/utils/is-unix-socket-url.js';
import test from './helpers/test.js';

test('returns socket path for unix: protocol URLs', _t => {
	const url = new URL('unix:/foo/bar.sock:/path');
	assert.strictEqual(getUnixSocketPath(url), '/foo/bar.sock');
});

test('returns socket path for http://unix URLs', _t => {
	const url = new URL('http://unix/foo/bar.sock:/path');
	assert.strictEqual(getUnixSocketPath(url), '/foo/bar.sock');
});

test('returns different socket paths for different sockets', _t => {
	const url1 = new URL('http://unix/tmp/socket1:/path');
	const url2 = new URL('http://unix/tmp/socket2:/path');

	assert.strictEqual(getUnixSocketPath(url1), '/tmp/socket1');
	assert.strictEqual(getUnixSocketPath(url2), '/tmp/socket2');
	assert.notStrictEqual(getUnixSocketPath(url1), getUnixSocketPath(url2));
});

test('returns undefined for regular HTTP URLs', _t => {
	const url = new URL('http://example.com/path');
	assert.strictEqual(getUnixSocketPath(url), undefined);
});

test('returns undefined for HTTPS URLs', _t => {
	const url = new URL('https://example.com/path');
	assert.strictEqual(getUnixSocketPath(url), undefined);
});

test('handles socket paths with special characters', _t => {
	const url = new URL('http://unix/tmp/my-app.sock:/api/endpoint');
	assert.strictEqual(getUnixSocketPath(url), '/tmp/my-app.sock');
});
