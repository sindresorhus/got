import test from 'ava';
import got from '../source';

test('should merge options replacing responseType', async t => {
	const responseType = 'json';
	const options = got.mergeOptions(got.defaults.options, {
		responseType,
	});

	t.is(options.responseType, responseType);
});
