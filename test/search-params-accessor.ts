import {Buffer} from 'node:buffer';
import test from 'ava';
import {expectTypeOf} from 'expect-type';
import ResponseLike from 'responselike';
import got from '../source/index.js';

test('normalized searchParams supports URLSearchParams methods and all input forms', async t => {
	await got('https://example.com/?page=1', {
		hooks: {
			beforeRequest: [options => {
				expectTypeOf(options.searchParams).toEqualTypeOf<URLSearchParams>();
				options.searchParams.set('page', '2');
				t.is(options.searchParams.get('page'), '2');
				options.searchParams = {page: 3};
				t.is(options.searchParams.get('page'), '3');
				options.searchParams = 'page=4';
				t.is(options.searchParams.get('page'), '4');
				options.searchParams = undefined;
				t.is(options.searchParams.size, 0);
				return new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('ok'),
					url: 'https://example.com',
				});
			}],
		},
	});
});
