import {Buffer} from 'node:buffer';
import test from 'ava';
import ResponseLike from 'responselike';
import got from '../source/index.js';

for (const responseType of ['text', 'buffer', 'json'] as const) {
	test(`pagination uses parseJson once for ${responseType} responses`, async t => {
		let calls = 0;
		const items = await got.paginate.all<string>('https://example.com/items', {
			responseType,
			parseJson(text) {
				calls++;
				t.is(text, '["original"]');
				return ['parsed'];
			},
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('["original"]'),
					url: 'https://example.com/items',
				})],
			},
		});

		t.deepEqual(items, ['parsed']);
		t.is(calls, 1);
	});
}

for (const responseType of ['text', 'buffer'] as const) {
	test(`pagination decodes and strips the BOM before custom parsing of ${responseType}`, async t => {
		const client = got.extend({
			responseType,
			encoding: 'utf16le',
			parseJson(text) {
				t.is(text, '["café"]');
				return ['custom'];
			},
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('﻿["café"]', 'utf16le'),
					url: 'https://example.com/items',
				})],
			},
		});

		t.deepEqual(await client.paginate.all<string>('https://example.com/items'), ['custom']);
	});

	test(`pagination propagates custom parser errors for ${responseType}`, async t => {
		const error = new Error('Custom parsing failed');
		await t.throwsAsync(got.paginate.all('https://example.com/items', {
			responseType,
			parseJson() {
				throw error;
			},
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from('[]'),
					url: 'https://example.com/items',
				})],
			},
		}), {is: error});
	});
}
