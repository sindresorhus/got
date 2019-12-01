import test from 'ava';
import got from '../source';

test('https request without ca', async t => {
	const responseType = 'json';
	const options = got.mergeOptions(got.defaults.options, {
		responseType,
	});

	t.is(options.responseType, responseType);
});
