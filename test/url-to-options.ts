import url = require('url');
import test from 'ava';
import urlToOptions from '../source/utils/url-to-options';

test('converts node legacy URL to options', t => {
	const exampleURL = 'https://user:password@github.com:443/say?hello=world#bang';
	const parsedURL = url.parse(exampleURL);
	const options = urlToOptions(parsedURL);
	const expected = {
		hash: '#bang',
		host: 'github.com:443',
		hostname: 'github.com',
		href: exampleURL,
		path: '/say?hello=world',
		pathname: '/say',
		port: 443,
		protocol: 'https:',
		search: '?hello=world'
	};

	t.deepEqual(options, expected);
});

test('converts URL to options', t => {
	const exampleURL = 'https://user:password@github.com:443/say?hello=world#bang';
	const parsedURL = new URL(exampleURL);
	const options = urlToOptions(parsedURL);
	const expected = {
		auth: 'user:password',
		hash: '#bang',
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://user:password@github.com/say?hello=world#bang',
		path: '/say?hello=world',
		pathname: '/say',
		protocol: 'https:',
		search: '?hello=world'
	};

	t.deepEqual(options, expected);
});

test('converts IPv6 URL to options', t => {
	const IPv6URL = 'https://[2001:cdba::3257:9652]:443/';
	const parsedURL = new URL(IPv6URL);
	const options = urlToOptions(parsedURL);
	const expected = {
		hash: '',
		host: '[2001:cdba::3257:9652]',
		hostname: '2001:cdba::3257:9652',
		href: 'https://[2001:cdba::3257:9652]/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: ''
	};

	t.deepEqual(options, expected);
});

test('only adds port to options for URLs with ports', t => {
	const noPortURL = 'https://github.com/';
	const parsedURL = new URL(noPortURL);
	const options = urlToOptions(parsedURL);
	const expected = {
		hash: '',
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://github.com/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: ''
	};

	t.deepEqual(options, expected);
	t.false(Reflect.has(options, 'port'));
});

test('does not concat null search to path', t => {
	const exampleURL = 'https://github.com/';
	const parsedURL = url.parse(exampleURL);

	t.is(parsedURL.search, null);

	const options = urlToOptions(parsedURL);
	const expected = {
		hash: null,
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://github.com/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: null
	};

	t.deepEqual(options, expected);
});

test('does not add null port to options', t => {
	const exampleURL = 'https://github.com/';
	const parsedURL = url.parse(exampleURL);

	t.is(parsedURL.port, null);

	const options = urlToOptions(parsedURL);
	const expected = {
		hash: null,
		host: 'github.com',
		hostname: 'github.com',
		href: 'https://github.com/',
		path: '/',
		pathname: '/',
		protocol: 'https:',
		search: null
	};

	t.deepEqual(options, expected);
});
