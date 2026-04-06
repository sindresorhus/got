import test from 'ava';
import got, {Options} from '../source/index.js';

test('should merge options replacing responseType', t => {
	const responseType = 'json';
	const options = new Options({
		responseType,
	}, undefined, got.defaults.options);

	t.is(options.responseType, responseType);
});

test('no duplicated searchParams values', t => {
	const options = new Options({
		searchParams: 'string=true&noDuplication=true',
	}, {
		searchParams: new URLSearchParams({
			instance: 'true',
			noDuplication: 'true',
		}),
	});

	// eslint-disable-next-line unicorn/prevent-abbreviations
	const searchParams = options.searchParams as URLSearchParams;

	t.is(searchParams.get('string'), 'true');
	t.is(searchParams.get('instance'), 'true');
	t.is(searchParams.getAll('noDuplication').length, 1);
});

test('should copy non-numerable properties', t => {
	const options = {
		json: {hello: '123'},
	};

	const merged = new Options(options, undefined, got.defaults.options);
	const mergedTwice = new Options(undefined, undefined, merged);

	t.is(mergedTwice.json, options.json);
});

test('should get username and password from the URL', t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
	});

	t.is(options.username, 'user');
	t.is(options.password, 'pass');
});

test('should get username and password from the options', t => {
	const options = new Options({
		url: 'http://user:pass@localhost:41285',
		username: 'user_OPT',
		password: 'pass_OPT',
	});

	t.is(options.username, 'user_OPT');
	t.is(options.password, 'pass_OPT');
});

test('should get username and password from the merged options', t => {
	const options = new Options(
		{
			url: 'http://user:pass@localhost:41285',
		},
		{
			username: 'user_OPT_MERGE',
			password: 'pass_OPT_MERGE',
		},
	);

	t.is(options.username, 'user_OPT_MERGE');
	t.is(options.password, 'pass_OPT_MERGE');
});

test('null value in search params means empty', t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: null as any,
		},
	});

	t.is((options.url as URL).href, 'http://localhost/?foo=');
});

test('undefined value in search params means it does not exist', t => {
	const options = new Options({
		url: new URL('http://localhost'),
		searchParams: {
			foo: undefined,
		},
	});

	t.is((options.url as URL).href, 'http://localhost/');
});

test('prefixUrl alone does not set url', t => {
	const options = new Options({
		prefixUrl: 'https://example.com',
	});

	t.is(options.url, undefined);
});

test('maxRetryAfter is calculated separately from request timeout', t => {
	const options = new Options({
		timeout: {
			request: 1000,
		},
		retry: {
			maxRetryAfter: undefined,
		},
	});

	t.is(options.retry.maxRetryAfter, undefined);

	options.merge({
		timeout: {
			request: 2000,
		},
	});

	t.is(options.retry.maxRetryAfter, undefined);

	options.merge({
		retry: {
			maxRetryAfter: 300,
		},
	});

	t.is(options.retry.maxRetryAfter, 300);
});

test('extending responseType', t => {
	const instance1 = got.extend({
		prefixUrl: 'https://localhost',
		responseType: 'json',
	});

	const instance2 = got.extend({
		headers: {
			'x-test': 'test',
		},
	});

	const merged = instance1.extend(instance2);

	t.is(merged.defaults.options.responseType, 'json');
});

test('searchParams - multiple values for one key', t => {
	const searchParameters = new URLSearchParams();

	searchParameters.append('a', '100');
	searchParameters.append('a', '200');
	searchParameters.append('a', '300');

	const options = new Options({
		searchParams: searchParameters,
	});

	t.deepEqual(
		(options.searchParams as URLSearchParams).getAll('a'),
		['100', '200', '300'],
	);
});

test('__proto__ in options does not cause prototype pollution', t => {
	const malicious = JSON.parse('{"method": "POST", "__proto__": {"injected": true}}');
	const options = new Options('https://example.com', malicious);

	t.is(Object.getPrototypeOf(options), Options.prototype);
	t.is(options.method, 'POST');
	t.is(typeof options.getInternalHeaders, 'function');
	t.is(({} as any).injected, undefined);
});

test('__proto__ in merge() does not cause prototype pollution', t => {
	const options = new Options('https://example.com');
	const malicious = JSON.parse('{"__proto__": {"injected": true}}');
	options.merge(malicious);

	t.is(Object.getPrototypeOf(options), Options.prototype);
	t.is(options.method, 'GET');
	t.is(typeof options.getInternalHeaders, 'function');
	t.is(({} as any).injected, undefined);
});

test('__proto__ in nested option objects does not cause prototype pollution', t => {
	const options = new Options('https://example.com');

	options.merge(JSON.parse('{"retry": {"__proto__": {"evil": true}}}'));
	t.is((options.retry as any).evil, undefined);

	options.merge(JSON.parse('{"timeout": {"__proto__": {"evil": true}}}'));
	t.is((options.timeout as any).evil, undefined);

	options.merge(JSON.parse('{"agent": {"__proto__": {"evil": true}}}'));
	t.is((options.agent as any).evil, undefined);

	options.merge(JSON.parse('{"https": {"__proto__": {"evil": true}}}'));
	t.is((options.https as any).evil, undefined);

	options.merge(JSON.parse('{"cacheOptions": {"__proto__": {"evil": true}}}'));
	t.is((options.cacheOptions as any).evil, undefined);

	options.merge(JSON.parse('{"context": {"__proto__": {"evil": true}}}'));
	t.is((options.context as any).evil, undefined);

	options.merge(JSON.parse('{"headers": {"__proto__": "leaked"}}'));
	t.false(Object.hasOwn(options.headers, '__proto__'));

	t.is(({} as any).evil, undefined);
});

test('__proto__ in searchParams does not cause prototype pollution', t => {
	const malicious = JSON.parse('{"searchParams": {"__proto__": {"evil": true}, "valid": "ok"}}');
	const options = new Options('https://example.com', malicious);

	t.is(({} as any).evil, undefined);
	const searchParameters = options.searchParams as URLSearchParams;
	t.is(searchParameters.get('valid'), 'ok');
	t.is(searchParameters.get('__proto__'), null);
});

if (globalThis.AbortSignal !== undefined) {
	test('signal does not get frozen', t => {
		const controller = new AbortController();
		const {signal} = controller;

		const options = new Options({
			url: new URL('http://localhost'),
			signal,
		});
		options.freeze();

		t.false(Object.isFrozen(options.signal));
	});
}
