import {URL, URLSearchParams} from 'url';
import test from 'ava';
import got from '../source';

test('should merge options replacing responseType', t => {
	const responseType = 'json';
	const options = got.mergeOptions(got.defaults.options, {
		responseType
	});

	t.is(options.responseType, responseType);
});

test('no duplicated searchParams values', t => {
	const options = got.mergeOptions(got.defaults.options, {
		searchParams: 'string=true&noDuplication=true'
	}, {
		searchParams: new URLSearchParams({
			instance: 'true',
			noDuplication: 'true'
		})
	});

	t.is(options.searchParams?.get('string'), 'true');
	t.is(options.searchParams?.get('instance'), 'true');
	t.is(options.searchParams?.getAll('noDuplication').length, 1);
});

test('should copy non-numerable properties', t => {
	const options = {
		json: {hello: '123'}
	};

	const merged = got.mergeOptions(got.defaults.options, options);
	const mergedTwice = got.mergeOptions(got.defaults.options, merged);

	t.is(mergedTwice.json, options.json);
});

test('should replace URLs', t => {
	const options = got.mergeOptions({
		url: new URL('http://localhost:41285'),
		searchParams: new URLSearchParams('page=0')
	}, {
		url: 'http://localhost:41285/?page=1',
		searchParams: undefined
	});

	const otherOptions = got.mergeOptions({
		url: new URL('http://localhost:41285'),
		searchParams: {
			page: 0
		}
	}, {
		url: 'http://localhost:41285/?page=1',
		searchParams: undefined
	});

	t.is(options.url.href, 'http://localhost:41285/?page=1');
	t.is(otherOptions.url.href, 'http://localhost:41285/?page=1');
});

test('should get username and password from the URL', t => {
	const options = got.mergeOptions({
		url: 'http://user:pass@localhost:41285'
	});

	t.is(options.username, 'user');
	t.is(options.password, 'pass');
});

test('should get username and password from the options', t => {
	const options = got.mergeOptions({
		url: 'http://user:pass@localhost:41285',
		username: 'user_OPT',
		password: 'pass_OPT'
	});

	t.is(options.username, 'user_OPT');
	t.is(options.password, 'pass_OPT');
});

test('should get username and password from the merged options', t => {
	const options = got.mergeOptions(
		{
			url: 'http://user:pass@localhost:41285'
		},
		{
			username: 'user_OPT_MERGE',
			password: 'pass_OPT_MERGE'
		}
	);

	t.is(options.username, 'user_OPT_MERGE');
	t.is(options.password, 'pass_OPT_MERGE');
});

test('null value in search params means empty', t => {
	const options = got.mergeOptions({
		url: new URL('http://localhost'),
		searchParams: {
			foo: null
		}
	});

	t.is(options.url.href, 'http://localhost/?foo=');
});

test('undefined value in search params means it does not exist', t => {
	const options = got.mergeOptions({
		url: new URL('http://localhost'),
		searchParams: {
			foo: undefined
		}
	});

	t.is(options.url.href, 'http://localhost/');
});
