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
