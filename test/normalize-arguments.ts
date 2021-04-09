import {URL, URLSearchParams} from 'url';
import test from 'ava';
import got, {Options} from '../source/index';

test('should merge options replacing responseType', t => {
	const responseType = 'json';
	const options = new Options({
		responseType
	}, undefined, got.defaults.options);

	t.is(options.responseType, responseType);
});

test('no duplicated searchParams values', t => {
	const options = new Options({
		searchParameters: 'string=true&noDuplication=true'
	}, {
		searchParameters: new URLSearchParams({
			instance: 'true',
			noDuplication: 'true'
		})
	});

	const searchParameters = options.searchParameters as URLSearchParams;

	t.is(searchParameters.get('string'), 'true');
	t.is(searchParameters.get('instance'), 'true');
	t.is(searchParameters.getAll('noDuplication').length, 1);
});

test('should copy non-numerable properties', t => {
	const options = {
		json: {hello: '123'}
	};

	const merged = new Options(options, undefined, got.defaults.options);
	const mergedTwice = new Options(undefined, undefined, merged);

	t.is(mergedTwice.json, options.json);
});

test('should replace URLs', t => {
	const options = new Options({
		url: new URL('http://localhost:41285'),
		searchParameters: new URLSearchParams('page=0')
	}, {
		url: 'http://localhost:41285/?page=1'
	});

	const otherOptions = new Options({
		url: new URL('http://localhost:41285'),
		searchParameters: {
			page: 0
		}
	}, {
		url: 'http://localhost:41285/?page=1'
	});

	t.is((options.url as URL).href, 'http://localhost:41285/?page=1');
	t.is((otherOptions.url as URL).href, 'http://localhost:41285/?page=1');
});

test('should get username and password from the URL', t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285'
	});

	t.is(options.username, 'user');
	t.is(options.password, 'pass');
});

test('should get username and password from the options', t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
		username: 'user_OPT',
		password: 'pass_OPT'
	});

	t.is(options.username, 'user_OPT');
	t.is(options.password, 'pass_OPT');
});

test('should get username and password from the merged options', t => {
	const options = new Options(
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
	const options = new Options({
		url: new URL('http://localhost'),
		searchParameters: {
			foo: null
		}
	});

	t.is((options.url as URL).href, 'http://localhost/?foo=');
});

test('undefined value in search params means it does not exist', t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParameters: {
			foo: undefined
		}
	});

	t.is((options.url as URL).href, 'http://localhost/');
});
