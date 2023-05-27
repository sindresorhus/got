import {parse as urlParse} from 'node:url';
import test from 'ava';
import urlToOptions from '../source/core/utils/url-to-options.js';

test('converts node legacy URL to options', t => {
	const exampleUrl = 'https://user:password@github.com:443/say?hello=world#bang';
	const parsedUrl = urlParse(exampleUrl);
	const options = urlToOptions(parsedUrl);
	const expected = {
		hash: '#bang',
		host: 'github.com:443',
		hostname: 'github.com',
		href: exampleUrl,
		path: '/say?hello=world',
		pathname: '/say',
		port: 443,
		protocol: 'https:',
		search: '?hello=world',
	};

	t.deepEqual(options, expected);
});

test('converts URL to options', t => {
	const exampleUrl = 'https://user:password@github.com:443/say?hello=world#bang';
	const parsedUrl = new URL(exampleUrl);
	const options = urlToOptions(parsedUrl);
	const expected = {
		auth: 'user:password',
		hash: '#bang',
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://user:password@github.com/say?hello=world#bang',
		path: '/say?hello=world',
		pathname: '/say',
		protocol: 'https:',
		search: '?hello=world',
	};

	t.deepEqual(options, expected);
});

test('converts IPv6 URL to options', t => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	const IPv6Url = 'https://[2001:cdba::3257:9652]:443/';
	const parsedUrl = new URL(IPv6Url);
	const options = urlToOptions(parsedUrl);
	const expected = {
		hash: '',
		host: '[2001:cdba::3257:9652]',
		hostname: '2001:cdba::3257:9652',
		href: 'https://[2001:cdba::3257:9652]/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: '',
	};

	t.deepEqual(options, expected);
});

test('only adds port to options for URLs with ports', t => {
	const noPortUrl = 'https://github.com/';
	const parsedUrl = new URL(noPortUrl);
	const options = urlToOptions(parsedUrl);
	const expected = {
		hash: '',
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://github.com/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: '',
	};

	t.deepEqual(options, expected);
	t.false(Reflect.has(options, 'port'));
});

test('does not concat null search to path', t => {
	const exampleUrl = 'https://github.com/';
	const parsedUrl = urlParse(exampleUrl);

	t.is(parsedUrl.search, null);

	const options = urlToOptions(parsedUrl);
	const expected = {
		hash: null,
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://github.com/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: null,
	};

	t.deepEqual(options, expected);
});

test('does not add null port to options', t => {
	const exampleUrl = 'https://github.com/';
	const parsedUrl = urlParse(exampleUrl);

	t.is(parsedUrl.port, null);

	const options = urlToOptions(parsedUrl);
	const expected = {
		hash: null,
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://github.com/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: null,
	};

	t.deepEqual(options, expected);
});

test('does not throw if there is no hostname', t => {
	t.notThrows(() => urlToOptions({} as URL));
});

test('null password', t => {
	const options = urlToOptions({
		username: 'foo',
		password: null,
	} as any);

	t.is(options.auth, 'foo:');
});

test('null username', t => {
	const options = urlToOptions({
		username: null,
		password: 'bar',
	} as any);

	t.is(options.auth, ':bar');
});
