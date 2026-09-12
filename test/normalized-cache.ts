import {Buffer} from 'node:buffer';
import test from 'ava';
import {expectTypeOf} from 'expect-type';
import ResponseLike from 'responselike';
import got, {type NormalizedOptions} from '../source/index.js';

test('normalized cache options support the documented setter inputs in hooks', async t => {
	expectTypeOf<string>().toExtend<NormalizedOptions['cache']>();

	await got('https://example.com', {
		hooks: {
			beforeRequest: [options => {
				options.cache = 'sqlite://cache';
				t.is(options.cache, 'sqlite://cache');
				options.cache = true;
				t.true(options.cache instanceof Map);
				options.cache = false;
				t.is(options.cache, undefined);
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
