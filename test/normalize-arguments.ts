import test from 'ava';
import got, {Options} from '../source';
import {normalizeArguments} from '../source/normalize-arguments';

test('should merge options replacing responseType', t => {
	const responseType = 'json';
	const options = got.mergeOptions(got.defaults.options, {
		responseType
	});

	t.is(options.responseType, responseType);
});

test('should be able to reuse options', t => {
	const options: Options = {};
	normalizeArguments('http://localhost', options);
	t.notThrows(() => normalizeArguments('http://localhost', options));
});

test.failing('should handle frozen objects', t => {
	const options: Options = Object.freeze({});
	t.notThrows(() => normalizeArguments('http://localhost', options));
});
