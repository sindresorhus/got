import test from 'ava';
import {URLSearchParams} from 'url';
import got from '../source';

test('should merge options replacing responseType', t => {
	const responseType = 'json';
	const options = got.mergeOptions(got.defaults.options, {
		responseType
	});

	t.is(options.responseType, responseType);
});

test('should merge searchParams', t => {
	const options = got.mergeOptions(got.defaults.options, {
		searchParams: 'string=true'
	}, {
		searchParams: new URLSearchParams({
			instance: 'true'
		})
	});

	t.is(options.searchParams?.get('string'), 'true');
	t.is(options.searchParams?.get('instance'), 'true');
});
