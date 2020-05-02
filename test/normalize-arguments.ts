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
