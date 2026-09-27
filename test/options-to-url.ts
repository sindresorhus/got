import test from 'ava';
import optionsToUrl from '../source/core/utils/options-to-url.js';

test('optionsToUrl applies the options to the origin', t => {
	t.is(optionsToUrl('https://example.com', {pathname: '/a'}).href, 'https://example.com/a');
	t.is(optionsToUrl('https://example.com', {port: 8080}).href, 'https://example.com:8080/');
	t.is(optionsToUrl('https://example.com/a', {search: '?b=1'}).href, 'https://example.com/a?b=1');
});

test('optionsToUrl splits a path into pathname and search', t => {
	t.is(optionsToUrl('https://example.com', {path: '/a?b=1'}).href, 'https://example.com/a?b=1');
	t.is(optionsToUrl('https://example.com', {path: '/a'}).href, 'https://example.com/a');
});

test('optionsToUrl applies searchParams', t => {
	t.is(optionsToUrl('https://example.com', {searchParams: {a: '1', b: '2'}}).href, 'https://example.com/?a=1&b=2');
	t.is(optionsToUrl('https://example.com', {searchParams: new URLSearchParams('a=1')}).href, 'https://example.com/?a=1');
	t.is(optionsToUrl('https://example.com/', {searchParams: {a: '1'}}).href, 'https://example.com/?a=1');
});

test('optionsToUrl applies an empty search to clear the query string', t => {
	t.is(optionsToUrl('https://example.com/?a=1', {search: ''}).href, 'https://example.com/');
});

test('optionsToUrl builds an origin from the protocol and host', t => {
	t.is(optionsToUrl('', {protocol: 'https:', host: 'example.com:8080'}).href, 'https://example.com:8080/');
	t.is(optionsToUrl('', {protocol: 'https:', hostname: 'example.com'}).href, 'https://example.com/');
});

test('optionsToUrl rejects a missing protocol', t => {
	t.throws(() => optionsToUrl('', {}), {message: 'No URL protocol specified'});
});

test('optionsToUrl rejects mutually exclusive parameters', t => {
	t.throws(() => optionsToUrl('https://example.com', {path: '/a', pathname: '/b'}), {message: 'Parameters `path` and `pathname` are mutually exclusive.'});
	t.throws(() => optionsToUrl('https://example.com', {path: '/a', search: '?b=1'}), {message: 'Parameters `path` and `search` are mutually exclusive.'});
	t.throws(() => optionsToUrl('https://example.com', {path: '/a', searchParams: {b: '1'}}), {message: 'Parameters `path` and `searchParams` are mutually exclusive.'});
	t.throws(() => optionsToUrl('https://example.com', {search: '?b=1', searchParams: {b: '1'}}), {message: 'Parameters `search` and `searchParams` are mutually exclusive.'});
	t.throws(() => optionsToUrl('https://example.com', {host: 'example.com', hostname: 'other.com'}), {message: 'Parameters `host` and `hostname` are mutually exclusive.'});
});
